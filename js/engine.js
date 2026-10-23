// Flow-based discrete-time simulator.
//
// Every tick (DT of simulated time) traffic is pushed from Users through the
// graph in topological order. Each node is a queue with a capacity; when load
// exceeds capacity a backlog builds, latency climbs (queueing theory), and
// once the backlog is too deep requests are dropped. A backward pass then
// folds downstream latency/errors into an end-to-end view per node, which is
// what callers (and the user) experience. Retries, timeouts, circuit
// breakers, replication lag, cache warmth, consumer lag etc. are all state
// that evolves between ticks.

import { CATALOG, COMPUTE_SIZES, DB_SIZES, withDefaults, nodeCost } from './catalog.js';

export const DT = 0.1;
const CLS = ['r', 'w', 's'];
const zero = () => ({ r: 0, w: 0, s: 0 });
const total = f => f.r + f.w + f.s;
const add = (a, b) => ({ r: a.r + b.r, w: a.w + b.w, s: a.s + b.s });
const scale = (f, k) => ({ r: f.r * k, w: f.w * k, s: f.s * k });
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const MAX_WAIT_S = 2; // backlog deeper than this many seconds of work gets dropped

const SVC_TYPES = new Set(['app', 'lb', 'gateway', 'dns']);
const STORE_TYPES = new Set(['sqldb', 'nosql', 'shard']);
const CALL_TYPES = new Set(['app', 'worker']);

export function patternFactor(pattern, t) {
  switch (pattern) {
    case 'diurnal': return 1 + 0.6 * Math.sin((2 * Math.PI * t) / 90 - Math.PI / 2);
    case 'spiky': return (t % 30) >= 15 && (t % 30) < 23 ? 4 : 1;
    case 'ramp': return Math.min(3, 0.25 + t / 40);
    default: return 1;
  }
}

// P(latency > timeout), with latency modelled as lognormal through (p50, p99).
function timeoutProb(p50, p99, timeoutMs) {
  if (!timeoutMs || p99 <= 0) return 0;
  const m = Math.max(p50, 0.01);
  const sigma = Math.max(0.05, (Math.log(Math.max(p99, m * 1.01)) - Math.log(m)) / 2.326);
  const z = (Math.log(timeoutMs) - Math.log(m)) / sigma;
  return clamp(1 - normCdf(z), 0, 1);
}
function normCdf(z) {
  // Abramowitz–Stegun approximation of the standard normal CDF.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function queueing(st, work, cap) {
  if (cap <= 0) return { servedFrac: work > 0 ? 0 : 1, util: work > 0 ? 9.99 : 0, rc: 0, waitMs: 0 };
  st.backlog = Math.max(0, st.backlog + (work - cap) * DT);
  const maxBacklog = cap * MAX_WAIT_S;
  let dropFrac = 0;
  if (st.backlog > maxBacklog) {
    const over = st.backlog - maxBacklog;
    st.backlog = maxBacklog;
    dropFrac = clamp(over / Math.max(work * DT, 1e-9), 0, 1);
  }
  const util = work / cap;
  const rc = Math.min(util, 0.95);
  return { servedFrac: 1 - dropFrac, util, rc, waitMs: (st.backlog / cap) * 1000 };
}

function latencyFrom(base, q) {
  const k = q.rc / (1 - q.rc);
  return { p50: base * (1 + 0.7 * k) + q.waitMs, p99: base * (1.8 + 3 * k) + q.waitMs * 1.3 + (q.waitMs > 0 ? base : 0) };
}

export class Simulation {
  constructor(graph, scenario = {}) {
    this.graph = graph;
    this.scenario = scenario;
    this.reset();
  }

  reset() {
    this.t = 0;
    this.tick = 0;
    this.ns = new Map(); // node id -> runtime state
    this.es = new Map(); // edge id -> runtime state
    this.history = [];
    this.log = [];
    this.insights = [];
    this.trafficMult = 1;
    this.spikes = [];
    this.totals = { lostWrites: 0, duplicates: 0, requests: 0, failed: 0 };
    this.metrics = blankMetrics();
    this.events = (this.scenario.events || []).map(e => ({ ...e, done: false }));
    this.seenInsights = new Set();
  }

  // ---------- state helpers ----------
  node(id) { return this._byId.get(id); }
  S(n) {
    let st = this.ns.get(n.id);
    if (!st) {
      st = {
        in: zero(), inRepl: 0, served: zero(), offered: zero(), backlog: 0,
        util: 0, cpu: 0, threadUtil: 0, dropFrac: 0, rejFrac: 0, ownStale: zero(), hit: 0,
        lat: { r: { p50: 0, p99: 0 }, w: { p50: 0, p99: 0 }, s: { p50: 0, p99: 0 } },
        e2e: { r: blankE2E(), w: blankE2E(), s: blankE2E() },
        down: false, downSince: -1, slow: false, warmth: 1, lag: 0.05,
        instances: n.params.instances ?? 1, pending: [], lastScale: 0,
        tokens: n.params.burst ?? 0, windowCount: 0, windowStart: 0,
        effCap: Infinity, failedNodes: 0, partitioned: false,
        migrationUntil: -1, migrationFrac: 0, prevShards: n.params.shards,
        backlogs: {}, qlag: 0, consumeRate: 0, redeliver: 0,
        failoverAt: -1, promoted: false, status: 'idle', notes: [], holdMs: 0,
      };
      this.ns.set(n.id, st);
    }
    return st;
  }
  E(e) {
    let st = this.es.get(e.id);
    if (!st) {
      st = { flow: zero(), intended: zero(), amp: 1, ampC: { r: 1, w: 1, s: 1 }, pa: zero(), pAttempt: 0, pFinal: 0, pLat: 0, cut: false, cb: { state: 'closed', since: 0, badFor: 0 }, frac: 1, repl: false, async: false, extraMs: 0, cutSince: -1 };
      this.es.set(e.id, st);
    }
    return st;
  }
  outEdges(n) { return this._out.get(n.id) || []; }
  inEdges(n) { return this._in.get(n.id) || []; }

  // ---------- topology ----------
  index() {
    const g = this.graph;
    this._byId = new Map(g.nodes.map(n => [n.id, n]));
    for (const n of g.nodes) n.params = withDefaults(n.type, n.params);
    this._out = new Map();
    this._in = new Map();
    const valid = g.edges.filter(e => this._byId.has(e.from) && this._byId.has(e.to) && e.from !== e.to);
    // Topological order; edges that close a cycle are ignored for routing.
    const color = new Map();
    const order = [];
    const back = new Set();
    const adj = new Map();
    for (const e of valid) { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from).push(e); }
    const visit = id => {
      color.set(id, 1);
      for (const e of adj.get(id) || []) {
        const c = color.get(e.to);
        if (c === 1) { back.add(e.id); continue; }
        if (!c) visit(e.to);
      }
      color.set(id, 2);
      order.push(id);
    };
    const roots = [...g.nodes].sort((a, b) => (a.type === 'client' ? -1 : 0) - (b.type === 'client' ? -1 : 0));
    for (const n of roots) if (!color.get(n.id)) visit(n.id);
    order.reverse();
    this.backEdges = back;
    for (const e of valid) {
      if (back.has(e.id)) continue;
      if (!this._out.has(e.from)) this._out.set(e.from, []);
      if (!this._in.has(e.to)) this._in.set(e.to, []);
      this._out.get(e.from).push(e);
      this._in.get(e.to).push(e);
    }
    this.order = order.map(id => this._byId.get(id));
  }

  // ---------- main loop ----------
  step() {
    this.index();
    this.applyEvents();
    for (const n of this.order) {
      const st = this.S(n);
      st.in = zero(); st.inRepl = 0; st.served = zero(); st.notes = [];
      if (!n.params.autoscale && n.params.instances != null) st.instances = n.params.instances;
    }
    for (const e of this.graph.edges) {
      const E = this.E(e);
      E.flow = zero(); E.intended = zero(); E.frac = 1; E.repl = false; E.async = false; E.extraMs = 0;
    }
    for (const n of this.order) this.process(n);
    for (let i = this.order.length - 1; i >= 0; i--) this.backward(this.order[i]);
    this.updateEdges();
    this.postTick();
    this.collect();
    this.t = +(this.t + DT).toFixed(4);
    this.tick++;
  }

  // ---------- events / chaos ----------
  applyEvents() {
    for (const ev of this.events) {
      if (ev.done || this.t + 1e-9 < ev.at) continue;
      ev.done = true;
      this.doAction(ev);
    }
    this.trafficMult = 1;
    for (const s of this.spikes) if (this.t >= s.from && this.t < s.until) this.trafficMult *= s.factor;
  }

  // Scenario events name a node by id, then label, then component type, so an
  // event still hits a component the learner added themselves (e.g. 'cache').
  findNode(ref) {
    if (!ref) return null;
    const r = String(ref).toLowerCase();
    return this.graph.nodes.find(n => n.id === ref)
      || this.graph.nodes.find(n => (n.label || '').toLowerCase() === r)
      || this.graph.nodes.find(n => n.type === ref);
  }

  doAction(ev) {
    const n = this.findNode(ev.target);
    switch (ev.do) {
      case 'kill': if (n) this.kill(n); break;
      case 'restore': if (n) this.restore(n); break;
      case 'slow': if (n) { this.S(n).slow = true; this.say('chaos', `${nm(n)} is running 10× slower (gray failure).`, n); } break;
      case 'unslow': if (n) { this.S(n).slow = false; this.say('info', `${nm(n)} recovered its normal speed.`, n); } break;
      case 'spike': {
        const dur = ev.duration ?? 20;
        this.spikes.push({ from: this.t, until: this.t + dur, factor: ev.factor ?? 5 });
        this.say('chaos', `Traffic spike: ${ev.factor ?? 5}× for ${dur}s.`);
        break;
      }
      case 'partition': {
        const e = this.graph.edges.find(x => x.id === ev.edge) || this.graph.edges.find(x => n && x.from === n.id && (!ev.to || x.to === (this.findNode(ev.to) || {}).id));
        if (e) { const E = this.E(e); E.cut = true; E.cutSince = this.t; this.say('chaos', `Network partition between ${nm(this._byId.get(e.from))} and ${nm(this._byId.get(e.to))}.`); }
        else if (n && n.type === 'nosql') { this.S(n).partitioned = true; this.say('chaos', `Network partition inside ${nm(n)}: about a third of nodes are cut off.`, n); }
        break;
      }
      case 'heal': {
        for (const e of this.graph.edges) this.E(e).cut = false;
        for (const x of this.graph.nodes) this.S(x).partitioned = false;
        this.say('info', 'Network healed.');
        break;
      }
      case 'failNode': if (n) { const st = this.S(n); st.failedNodes = Math.min((n.params.nodes || 1), st.failedNodes + 1); this.say('chaos', `One node of ${nm(n)} failed (${st.failedNodes} down).`, n); } break;
      case 'region': {
        const r = ev.region || 'us-east';
        let k = 0;
        for (const x of this.graph.nodes) if (x.params.region === r && !this.S(x).down) { this.kill(x, true); k++; }
        this.say('chaos', `Region outage: ${r} is down (${k} components).`);
        break;
      }
      case 'say': this.say(ev.level || 'info', ev.text); break;
    }
  }

  kill(n, quiet) {
    const st = this.S(n);
    if (st.down) return;
    st.down = true; st.downSince = this.t; st.backlog = 0;
    if (n.type === 'cache' && n.params.strategy === 'write-back') {
      const lost = Math.round(st.in.w * 5);
      if (lost > 0) { this.totals.lostWrites += lost; this.say('bad', `Write-back cache crashed: ~${fmtInt(lost)} buffered writes were never flushed to the database. Lost forever.`, n); }
    }
    if (n.type === 'sqldb') st.failoverAt = -1;
    if (!quiet) this.say('chaos', `${nm(n)} went down.`, n);
  }

  restore(n) {
    const st = this.S(n);
    if (!st.down) return;
    st.down = false; st.downSince = -1; st.promoted = false;
    if (n.type === 'cache') { st.warmth = 0; this.say('info', `${nm(n)} restarted with an empty (cold) cache.`, n); }
    else this.say('info', `${nm(n)} is back up.`, n);
  }

  say(level, text, n) {
    this.log.push({ t: this.t, level, text, node: n ? n.id : null });
    if (this.log.length > 400) this.log.shift();
  }

  // ---------- forward pass ----------
  send(e, intended, caller) {
    const E = this.E(e);
    const tgt = this._byId.get(e.to);
    E.intended = add(E.intended, intended);
    let frac = 1;
    if (caller.params.circuitBreaker && CALL_TYPES.has(caller.type)) {
      if (E.cb.state === 'open') frac = 0;
      else if (E.cb.state === 'half') frac = 0.1;
      else if (E.cb.state === 'ramp') frac = Math.min(1, 0.1 + ((this.t - E.cb.since) / 5) * 0.9);
    }
    E.frac = frac;
    const retrying = (caller.params.retries || 0) > 0;
    const a = E.ampC;
    const wire = retrying
      ? { r: intended.r * frac * a.r, w: intended.w * frac * a.w, s: intended.s * frac * a.s }
      : scale(intended, frac);
    E.flow = add(E.flow, wire);
    if (!E.cut && tgt) {
      const ts = this.S(tgt);
      if (caller.type === 'sqldb' && tgt.type === 'replica') { ts.inRepl += wire.w; E.repl = true; }
      else ts.in = add(ts.in, wire);
    }
  }

  split(targets, flow, caller, weights) {
    if (!targets.length || total(flow) <= 0) return;
    const w = weights || targets.map(() => 1);
    const sum = w.reduce((a, b) => a + b, 0) || 1;
    targets.forEach((x, i) => this.send(x.e, scale(flow, w[i] / sum), caller));
  }

  outs(n) {
    return this.outEdges(n).map(e => ({ e, t: this._byId.get(e.to) })).filter(x => x.t);
  }

  healthyFor(caller, x, detectS = 2) {
    const ts = this.S(x.t);
    const E = this.E(x.e);
    if (ts.down && this.t - ts.downSince >= detectS) return false;
    if (E.cut && this.t - E.cutSince >= detectS) return false;
    if (ts.failingSince != null && this.t - ts.failingSince >= detectS) return false;
    return true;
  }

  process(n) {
    const st = this.S(n);
    const p = n.params;
    const inF = st.in;
    st.dropFrac = 0; st.rejFrac = 0; st.ownStale = zero(); st.hit = 0; st.extErr = 0;
    if (n.type === 'client') return this.processClient(n, st, p);
    if (st.down) {
      st.util = 0; st.cpu = 0; st.threadUtil = 0; st.dropFrac = total(inF) > 0 || st.inRepl > 0 ? 1 : 0;
      st.status = 'down';
      for (const c of CLS) st.lat[c] = { p50: 0, p99: 0 };
      if (n.type === 'sqldb') this.maybeFailover(n, st, p);
      return;
    }
    const fn = this['p_' + n.type];
    if (fn) fn.call(this, n, st, p, inF);
    st.status = statusOf(st);
  }

  processClient(n, st, p) {
    const f = patternFactor(p.pattern, this.t) * this.trafficMult;
    const tot = p.rps * f;
    const reads = tot * p.readRatio;
    const off = { r: reads * (1 - p.staticRatio), s: reads * p.staticRatio, w: tot * (1 - p.readRatio) };
    st.offered = off; st.in = off; st.served = off; st.status = 'healthy';
    const outs = this.outs(n);
    for (const x of outs) this.E(x.e).extraMs = x.t.type === 'cdn' ? 15 : p.rttMs;
    if (outs.length) this.split(outs, off, n);
  }

  setLat(st, base, q, cls = CLS) {
    for (const c of CLS) st.lat[c] = { p50: 0, p99: 0 };
    for (const c of cls) {
      const b = typeof base === 'number' ? base : base[c];
      st.lat[c] = latencyFrom(b, q);
    }
  }

  p_dns(n, st, p, inF) {
    const q = { servedFrac: 1, util: 0, rc: 0, waitMs: 0 };
    st.util = 0; this.setLat(st, 1, q);
    st.served = inF;
    let outs = this.outs(n);
    if (p.healthChecks) {
      // Clients keep using a cached answer for up to one TTL after failover.
      const healthy = outs.filter(x => this.healthyFor(n, x, Math.min(p.ttl, 120)));
      if (healthy.length) outs = healthy;
    }
    if (!outs.length) return;
    if (p.mode === 'failover') this.send(outs[0].e, inF, n);
    else if (p.mode === 'latency') this.split(outs, inF, n, outs.map(x => 1 / Math.max(1, this.S(x.t).e2e.r.p50 + 1)));
    else this.split(outs, inF, n);
  }

  p_cdn(n, st, p, inF) {
    const sHit = p.staticHit;
    const rHit = p.cacheApi ? p.apiHit : 0;
    st.hit = (inF.s * sHit + inF.r * rHit) / Math.max(1e-9, inF.s + inF.r);
    st.util = 0;
    this.setLat(st, 5, { servedFrac: 1, util: 0, rc: 0, waitMs: 0 });
    st.served = inF;
    st.hitByClass = { r: rHit, w: 0, s: sHit };
    const outs = this.outs(n);
    for (const x of outs) this.E(x.e).extraMs = p.originRttMs;
    const blobs = outs.filter(x => x.t.type === 'blob');
    const origin = outs.filter(x => x.t.type !== 'blob');
    const missS = inF.s * (1 - sHit);
    const dyn = { r: inF.r * (1 - rHit), w: inF.w, s: 0 };
    if (blobs.length) { this.split(blobs, { r: 0, w: 0, s: missS }, n); this.split(origin, dyn, n); }
    else this.split(origin, { ...dyn, s: missS }, n);
  }

  p_lb(n, st, p, inF) {
    const cap = 20000 * p.instances;
    const q = queueing(st, total(inF), cap);
    st.util = q.util; st.cpu = q.util; st.dropFrac = 1 - q.servedFrac;
    this.setLat(st, 1, q);
    const served = scale(inF, q.servedFrac);
    st.served = served;
    let outs = this.outs(n);
    if (p.healthChecks) outs = outs.filter(x => this.healthyFor(n, x));
    // Outlier detection (Envoy-style): eject targets far slower than their peers.
    st.ejected = 0;
    if (p.outlierDetection && outs.length > 1) {
      const lat = x => Math.max(this.S(x.t).e2e.r.p50, this.S(x.t).e2e.w.p50, 0.1);
      const sorted = outs.map(lat).sort((a, b) => a - b);
      const median = sorted[Math.floor((sorted.length - 1) / 2)];
      const keep = outs.filter(x => lat(x) <= median * 3);
      if (keep.length) { st.ejected = outs.length - keep.length; outs = keep; }
    }
    if (!outs.length) { st.dropFrac = total(inF) > 0 ? 1 : 0; st.noTargets = true; return; }
    st.noTargets = false;
    let weights;
    if (p.algorithm === 'least-connections') {
      weights = outs.map(x => {
        const ts = this.S(x.t);
        const cap = isFinite(ts.effCap) ? ts.effCap : 1000;
        return Math.max(cap * 0.02, cap - total(ts.in) * 0.5) / Math.max(1, ts.holdMs / 20);
      });
    } else if (p.algorithm === 'random') {
      weights = outs.map((x, i) => 1 + 0.25 * Math.sin(this.t * 3.7 + i * 2.1));
    }
    this.split(outs, served, n, weights);
  }

  p_gateway(n, st, p, inF) {
    const cap = 20000 * p.instances;
    let allowedFrac = 1;
    let extraWait = 0;
    const tot = total(inF);
    if (p.rateLimit && tot > 0) {
      if (p.algorithm === 'fixed-window') {
        if (this.t - st.windowStart >= 1 - 1e-9) { st.windowStart = this.t; st.windowCount = 0; }
        const room = Math.max(0, p.limitRps - st.windowCount);
        const want = tot * DT;
        const ok = Math.min(want, room);
        st.windowCount += ok;
        allowedFrac = ok / want;
      } else if (p.algorithm === 'leaky-bucket') {
        // Queue up to `burst` requests and drain at the limit rate.
        st.lbq = (st.lbq || 0) + tot * DT;
        const out = Math.min(st.lbq, p.limitRps * DT);
        st.lbq -= out;
        let rejected = 0;
        if (st.lbq > p.burst) { rejected = st.lbq - p.burst; st.lbq = p.burst; }
        allowedFrac = clamp(1 - rejected / (tot * DT), 0, 1);
        extraWait = (st.lbq / p.limitRps) * 1000;
      } else {
        st.tokens = Math.min(p.burst + p.limitRps * DT, st.tokens + p.limitRps * DT);
        const want = tot * DT;
        const ok = Math.min(want, st.tokens);
        st.tokens -= ok;
        allowedFrac = ok / want;
      }
    } else st.tokens = p.burst;
    st.rejFrac = 1 - allowedFrac;
    const allowed = scale(inF, allowedFrac);
    const q = queueing(st, total(allowed), cap);
    st.util = q.util; st.cpu = q.util; st.dropFrac = (1 - q.servedFrac);
    this.setLat(st, 2, { ...q, waitMs: q.waitMs + extraWait });
    st.served = scale(allowed, q.servedFrac);
    this.split(this.outs(n), st.served, n);
  }

  computeCapacity(n, st, p, reqIn, cpuWork) {
    const size = COMPUTE_SIZES[p.size] || COMPUTE_SIZES.S;
    const inst = Math.max(0, st.instances);
    const slow = st.slow ? 10 : 1;
    const cpuCap = (inst * size.cap) / (st.slow ? 3 : 1);
    const base = p.baseMs * slow;
    // Little's law: a request holds a thread for its own time + downstream wait
    // (bounded by the timeout). Slow dependencies exhaust thread pools.
    let downMs = st.downWaitMs || 0;
    if (p.timeoutMs > 0) downMs = Math.min(downMs, p.timeoutMs * (1 + (p.retries || 0)));
    st.holdMs = base + downMs;
    const threadCap = (inst * size.threads) / (st.holdMs / 1000);
    const cpuCapReq = cpuWork > 0 ? cpuCap * (reqIn / cpuWork) : cpuCap;
    const effCap = Math.min(cpuCapReq, threadCap);
    st.effCap = effCap;
    st.cpuCap = cpuCap;
    st.threadCap = threadCap;
    return { effCap, cpuCap, base, threadCap };
  }

  p_app(n, st, p, inF) {
    const staticCost = 0.5 + (this.ctx(n).staticKB || 200) / 200;
    const reqIn = total(inF);
    const cpuWork = inF.r + inF.w + inF.s * staticCost;
    const cap = this.computeCapacity(n, st, p, reqIn, cpuWork);
    const q = queueing(st, reqIn, cap.effCap);
    st.util = q.util;
    st.cpu = Math.min(1, cpuWork / Math.max(cap.cpuCap, 1e-9));
    st.threadUtil = Math.min(1, reqIn / Math.max(cap.threadCap, 1e-9));
    st.dropFrac = 1 - q.servedFrac;
    this.setLat(st, cap.base, q);
    st.served = scale(inF, q.servedFrac);
    this.routeData(n, st.served, st);
  }

  p_worker(n, st, p, inF) { this.p_app(n, st, p, inF); }

  routeData(n, served, st) {
    const p = n.params;
    const outs = this.outs(n);
    const by = t => outs.filter(x => x.t.type === t);
    const svc = outs.filter(x => SVC_TYPES.has(x.t.type));
    const ext = by('external');
    // A dead cache or replica is skipped after a short detection delay: the app
    // falls back to the next option (usually the primary database).
    const queues = by('queue'), blobs = by('blob');
    // A crashed process refuses connections immediately; a partition only shows up via timeouts.
    const caches = by('cache').filter(x => !this.S(x.t).down && this.healthyFor(n, x));
    const replicas = by('replica').filter(x => !this.S(x.t).down && this.healthyFor(n, x));
    const stores = outs.filter(x => STORE_TYPES.has(x.t.type));
    const workers = by('worker');
    for (const x of svc) this.send(x.e, served, n);
    for (const x of workers) this.send(x.e, served, n);
    for (const x of ext) this.send(x.e, x.t.params.invokedFor === 'all' ? served : { r: 0, w: served.w, s: 0 }, n);
    // Reads: cache first, then replicas, then the primary store.
    const r = served.r;
    if (r > 0) {
      if (caches.length) this.split(caches, { r, w: 0, s: 0 }, n);
      else if (replicas.length) {
        let toPrimary = 0;
        const sqlPrimaries = stores.filter(x => x.t.type === 'sqldb');
        if (p.readYourWrites && sqlPrimaries.length) toPrimary = r * Math.min(0.3, 2 * served.w / Math.max(1e-9, total(served)));
        this.split(replicas, { r: r - toPrimary, w: 0, s: 0 }, n);
        if (toPrimary > 0) this.split(sqlPrimaries, { r: toPrimary, w: 0, s: 0 }, n);
      } else if (stores.length) this.split(stores, { r, w: 0, s: 0 }, n);
    }
    // Writes: queue (async) > write-through/back cache > primary store > cache passthrough.
    const w = served.w;
    if (w > 0) {
      const wcaches = caches.filter(x => x.t.params.strategy !== 'cache-aside');
      if (queues.length) this.split(queues, { r: 0, w, s: 0 }, n);
      else if (wcaches.length) this.split(wcaches, { r: 0, w, s: 0 }, n);
      else if (stores.length) this.split(stores, { r: 0, w, s: 0 }, n);
      else if (caches.length) this.split(caches, { r: 0, w, s: 0 }, n);
      else if (blobs.length) this.split(blobs, { r: 0, w, s: 0 }, n); // e.g. uploads / transcoded files
    }
    if (served.s > 0 && blobs.length) this.split(blobs, { r: 0, w: 0, s: served.s }, n);
  }

  // Context from the users driving this graph (hot data size, asset size).
  ctx() {
    if (this._ctxTick === this.tick) return this._ctx;
    const clients = this.graph.nodes.filter(x => x.type === 'client');
    const c = { workingSetGB: 20, staticKB: 200 };
    if (clients.length) {
      c.workingSetGB = Math.max(...clients.map(x => x.params.workingSetGB || 20));
      c.staticKB = Math.max(...clients.map(x => x.params.staticKB || 200));
    }
    this._ctx = c; this._ctxTick = this.tick;
    return c;
  }

  p_cache(n, st, p, inF) {
    const ws = this.ctx(n).workingSetGB;
    const memHit = 1 - Math.exp((-2.5 * p.memoryGB * Math.max(1, p.nodes)) / ws);
    const ttlHit = p.ttlSec / (p.ttlSec + 5);
    const hit = clamp(memHit * ttlHit, 0, 0.99) * st.warmth;
    st.hit = hit;
    const cap = 100000 * Math.max(1, p.nodes);
    const q = queueing(st, total(inF), cap);
    st.util = q.util; st.cpu = q.util; st.dropFrac = 1 - q.servedFrac;
    this.setLat(st, 0.8, q);
    const served = scale(inF, q.servedFrac);
    st.served = served;
    st.hitByClass = { r: hit, w: p.strategy === 'write-back' ? 1 : 0, s: 0 };
    // Stampede: when cold, many requests miss on the same hot keys at once.
    const stampede = p.coalescing ? 1 : 1 + 4 * (1 - st.warmth);
    st.stampede = stampede;
    const misses = served.r * (1 - hit) * stampede;
    const wShare = served.w / Math.max(1e-9, served.r + served.w);
    if (p.strategy === 'cache-aside') st.ownStale.r = hit * clamp(wShare * p.ttlSec / 300, 0, 0.5);
    else st.ownStale.r = hit * 0.001;
    const outs = this.outs(n).filter(x => x.t.type !== 'cache');
    const writes = p.strategy === 'write-back' ? served.w * 0.3 : served.w;
    this.split(outs, { r: misses, w: writes, s: 0 }, n);
    if (p.strategy === 'write-back') for (const x of outs) this.E(x.e).async = true;
  }

  p_sqldb(n, st, p, inF) {
    st.promoted = st.promoted || false;
    const size = DB_SIZES[p.size] || DB_SIZES.M;
    const readCost = p.indexed ? 1 : 15;
    const iso = { 'read-committed': 1, 'repeatable-read': 1.3, 'serializable': 2.2 }[p.isolation] || 1;
    const writeCost = 4 * iso;
    const cap = size.cap / (st.slow ? 4 : 1);
    const work = inF.r * readCost + inF.w * writeCost;
    const q = queueing(st, work, cap);
    st.util = q.util; st.cpu = q.util; st.dropFrac = 1 - q.servedFrac;
    st.readWork = inF.r * readCost; st.writeWork = inF.w * writeCost;
    const slow = st.slow ? 10 : 1;
    this.setLat(st, { r: (p.indexed ? 4 : 60) * slow, w: 8 * iso * slow, s: 0 }, q);
    const served = scale(inF, q.servedFrac);
    st.served = served;
    const outs = this.outs(n);
    const reps = outs.filter(x => x.t.type === 'replica' && !this.S(x.t).promoted);
    st.syncBlocked = false;
    for (const x of reps) {
      this.send(x.e, { r: 0, w: served.w, s: 0 }, n);
    }
    if (p.replication === 'sync' && reps.length) {
      const bad = reps.some(x => this.S(x.t).down || this.E(x.e).cut);
      if (bad) { st.syncBlocked = true; st.ownErrW = 1; }
      else {
        const worst = Math.max(...reps.map(x => this.S(x.t).lat.r.p99 || 4));
        st.lat.w = { p50: st.lat.w.p50 + 3 + worst * 0.5, p99: st.lat.w.p99 + 6 + worst };
      }
    }
    // Primary → other stores (rare): pass writes through.
    for (const x of outs) if (x.t.type !== 'replica' && x.t.type !== 'sqldb') this.send(x.e, { r: 0, w: served.w, s: 0 }, n);
  }

  maybeFailover(n, st, p) {
    if (!p.autoFailover) return;
    const reps = this.outs(n).filter(x => x.t.type === 'replica' && !this.S(x.t).down && !this.S(x.t).promoted);
    if (!reps.length) return;
    if (st.failoverAt < 0) { st.failoverAt = this.t + 15; this.say('info', `${nm(n)} is down. Failover will promote a replica in ~15s.`, n); return; }
    if (this.t >= st.failoverAt) {
      const r = reps[0];
      const rs = this.S(r.t);
      const lost = p.replication === 'async' ? Math.round((this.metrics.writeRps || 0) * Math.max(0.05, rs.lag)) : 0;
      if (lost > 0) this.totals.lostWrites += lost;
      rs.down = true; rs.downSince = this.t; rs.promoted = true;
      st.down = false; st.downSince = -1; st.failoverAt = -1; st.backlog = 0;
      this.say('good', `Failover complete: ${nm(r.t)} promoted to primary.${lost ? ` Async replication lost ~${fmtInt(lost)} recent writes (replication lag window).` : ' No writes lost (sync replication).'}`, n);
    }
  }

  p_replica(n, st, p, inF) {
    const size = DB_SIZES[p.size] || DB_SIZES.M;
    const cap = size.cap / (st.slow ? 4 : 1);
    const apply = st.inRepl * 2; // applying a replicated write is cheaper than executing it
    const primaryEdges = this.inEdges(n).filter(e => (this._byId.get(e.from) || {}).type === 'sqldb');
    const primaryOk = primaryEdges.some(e => !this.E(e).cut && !this.S(this._byId.get(e.from)).down);
    // A dead primary commits no new writes, so lag only grows on a real partition.
    const partitioned = primaryEdges.length > 0 && primaryEdges.every(e => this.E(e).cut);
    const work = inF.r + apply;
    const q = queueing(st, work, cap);
    st.util = q.util; st.cpu = q.util; st.dropFrac = 1 - q.servedFrac;
    this.setLat(st, { r: 4 * (st.slow ? 10 : 1), w: 0, s: 0 }, q, ['r']);
    st.served = scale(inF, q.servedFrac);
    if (!primaryEdges.length) st.lag = 0;
    else if (partitioned) st.lag += DT;
    else if (!primaryOk) { /* primary down: nothing new to replicate */ }
    else if (q.util > 1) st.lag += DT * (q.util - 1) * 3;
    else st.lag = Math.max(0.05, st.lag - DT * (1 - q.util) * 3);
    st.noPrimary = !primaryEdges.length;
    st.ownStale.r = primaryEdges.length ? clamp(0.004 + st.lag * 0.05, 0, 0.9) : 0;
  }

  p_nosql(n, st, p, inF) {
    const N = Math.max(1, p.nodes);
    const rf = Math.min(p.rf, N);
    const quorum = Math.floor(rf / 2) + 1;
    const need = { ONE: 1, QUORUM: quorum, ALL: rf }[p.consistency] || quorum;
    const work = inF.r * need + inF.w * rf;
    const alive = N - st.failedNodes;
    const hotShare = (1 - p.hotKeySkew) / Math.max(1, alive) + p.hotKeySkew / Math.max(1, Math.min(rf, need === 1 ? rf : need));
    const avgShare = 1 / Math.max(1, alive);
    const nodeCap = 5000 / (st.slow ? 4 : 1);
    // The hottest node saturates first.
    const capEff = alive > 0 ? nodeCap / Math.max(hotShare, avgShare) : 0;
    const q = queueing(st, work, capEff);
    st.util = q.util; st.cpu = q.util; st.dropFrac = 1 - q.servedFrac;
    st.hotShare = hotShare;
    const extra = { ONE: 0, QUORUM: 2, ALL: 6 }[p.consistency] || 0;
    this.setLat(st, { r: 3 + extra, w: 5 + extra, s: 0 }, q);
    // Availability under node failures / partitions.
    let unavailable = 0;
    const lostReplicas = st.failedNodes;
    if (lostReplicas > 0) {
      const tolerate = rf - need;
      if (lostReplicas > tolerate) unavailable = clamp((lostReplicas - tolerate) / N * rf, 0, 1);
    }
    let stale = rf > 1 && p.consistency === 'ONE' ? 0.02 : 0;
    if (st.partitioned) {
      if (p.consistency === 'ONE') stale = 0.3;
      else if (p.consistency === 'QUORUM') unavailable = Math.max(unavailable, 0.33);
      else unavailable = Math.max(unavailable, rf > 1 ? 0.9 : 0.33);
    }
    st.unavailable = unavailable;
    st.dropFrac = 1 - (1 - st.dropFrac) * (1 - unavailable);
    st.ownStale.r = stale;
    st.served = scale(inF, 1 - st.dropFrac);
  }

  p_shard(n, st, p, inF) {
    const N = Math.max(1, p.shards);
    if (st.prevShards !== N) {
      const old = st.prevShards || N;
      // mod-N: a key stays put only if k mod old == k mod new → min/lcm of keys stay.
      // consistent hashing: only the ring segments that change owner move.
      st.migrationFrac = p.partitioning === 'hash-mod-n'
        ? 1 - Math.min(old, N) / lcm(old, N)
        : Math.abs(N - old) / Math.max(N, old);
      st.migrationUntil = this.t + 25;
      this.say('info', `Resharding ${old} → ${N} shards with ${p.partitioning}: ~${Math.round(st.migrationFrac * 100)}% of keys must move.`, n);
      st.prevShards = N;
    }
    const shardCap = DB_SIZES.M.cap / (st.slow ? 4 : 1);
    const wCost = 4;
    const migrating = this.t < st.migrationUntil;
    const migLoad = migrating ? shardCap * 0.8 * st.migrationFrac : 0;
    let hotR = (1 - p.hotKeySkew) / N + p.hotKeySkew;
    let hotW = hotR;
    if (p.partitioning === 'range') hotW = Math.max(hotW, 0.85); // monotonic keys all land on the newest range
    const hottestWork = inF.r * hotR + inF.w * wCost * hotW + migLoad;
    const avgWork = (inF.r + inF.w * wCost) / N + migLoad;
    const work = Math.max(hottestWork, avgWork);
    const q = queueing(st, work, shardCap);
    st.util = q.util; st.cpu = q.util; st.dropFrac = 1 - q.servedFrac;
    st.hotShare = Math.max(hotR, hotW);
    st.migrating = migrating;
    this.setLat(st, { r: 4, w: 9, s: 0 }, q);
    st.served = scale(inF, q.servedFrac);
  }

  p_queue(n, st, p, inF) {
    const cap = p.partitions * 5000;
    const arrivals = inF.r + inF.w;
    const q = queueing({ backlog: 0 }, arrivals, cap); // ingest capacity
    st.util = arrivals / cap; st.cpu = st.util;
    let dropFrac = arrivals > cap ? 1 - cap / arrivals : 0;
    this.setLat(st, 3, { ...q, waitMs: 0 });
    const outs = this.outs(n);
    const workers = outs.filter(x => x.t.type === 'worker');
    const others = outs.filter(x => x.t.type !== 'worker');
    const groups = p.mode === 'pub-sub' ? workers.map(x => [x]) : (workers.length ? [workers] : []);
    const accepted = arrivals * (1 - dropFrac);
    const maxB = p.maxBacklogM * 1e6;
    let maxLag = 0, totalB = 0, consume = 0;
    const live = new Set();
    groups.forEach((grp, gi) => {
      const key = grp.map(x => x.t.id).join('+');
      live.add(key);
      let B = st.backlogs[key] || 0;
      // Redelivery: messages a worker failed come back (at-least-once).
      let redeliver = 0;
      for (const x of grp) {
        const ws = this.S(x.t);
        redeliver += this.E(x.e).flow.w * (ws.e2e.w.err || 0);
      }
      B += (accepted + redeliver) * DT;
      const inst = grp.reduce((a, x) => a + (this.S(x.t).down ? 0 : Math.max(0, this.S(x.t).instances)), 0);
      const parallel = Math.min(inst, p.partitions);
      const capSum = grp.reduce((a, x) => a + (this.S(x.t).down ? 0 : (isFinite(this.S(x.t).effCap) ? this.S(x.t).effCap : 1000)), 0);
      const C = inst > 0 ? capSum * (parallel / inst) : 0;
      const drain = Math.min(B / DT, C);
      B -= drain * DT;
      if (B > maxB) { dropFrac = Math.max(dropFrac, (B - maxB) / Math.max(1, accepted * DT)); B = maxB; }
      st.backlogs[key] = B;
      const lag = drain > 0 ? B / drain : (B > 0 ? B / Math.max(1, accepted) : 0);
      maxLag = Math.max(maxLag, lag);
      totalB += B;
      consume += drain;
      st.idleConsumers = Math.max(st.idleConsumers || 0, inst - parallel);
      const ws = grp.map(x => isFinite(this.S(x.t).effCap) && !this.S(x.t).down ? this.S(x.t).effCap : 0);
      this.split(grp, { r: 0, w: drain, s: 0 }, n, ws.every(v => v === 0) ? null : ws);
      for (const x of grp) this.E(x.e).async = true;
      st.redeliver = redeliver;
      if (gi === 0) st.idleConsumers = inst - parallel;
    });
    for (const k of Object.keys(st.backlogs)) if (!live.has(k)) delete st.backlogs[k];
    if (others.length) {
      this.split(others, { r: 0, w: accepted, s: 0 }, n);
      for (const x of others) this.E(x.e).async = true;
    }
    st.qlag = maxLag; st.qBacklog = totalB; st.consumeRate = consume;
    st.dropFrac = clamp(dropFrac, 0, 1);
    st.served = scale(inF, 1 - st.dropFrac);
  }

  p_blob(n, st, p, inF) {
    const cap = 50000;
    const q = queueing(st, total(inF), cap);
    st.util = q.util; st.cpu = q.util; st.dropFrac = 1 - q.servedFrac;
    this.setLat(st, 30, q);
    st.served = scale(inF, q.servedFrac);
  }

  p_external(n, st, p, inF) {
    const tot = total(inF);
    const over = tot > p.quotaRps ? 1 - p.quotaRps / tot : 0;
    st.util = tot / p.quotaRps; st.cpu = st.util;
    st.quotaFrac = over;
    st.dropFrac = 1 - (1 - over) * (1 - p.errorRate);
    this.setLat(st, p.latencyMs * (st.slow ? 10 : 1), { servedFrac: 1, util: 0, rc: Math.min(0.5, st.util * 0.3), waitMs: 0 });
    st.served = scale(inF, 1 - st.dropFrac);
  }

  // ---------- backward pass: end-to-end view ----------
  backward(n) {
    const st = this.S(n);
    const p = n.params;
    const callType = CALL_TYPES.has(n.type);
    const outs = this.outs(n);
    for (const x of outs) { const E = this.E(x.e); E.paW = 0; E.plW = 0; E.iW = 0; E.pa = zero(); }
    for (const c of CLS) {
      const own = st.lat[c];
      let ownErr = st.dropFrac;
      if (n.type === 'sqldb' && c === 'w' && st.syncBlocked) ownErr = 1;
      if (st.down) ownErr = 1;
      const rej0 = st.rejFrac || 0;
      const servedC = Math.max(1e-12, (n.type === 'client' ? st.offered[c] : st.served[c]));
      let p50 = own.p50, p99 = own.p99;
      let errDown = callType ? 1 : 0; // product form for calls, sum form for splits
      let errSum = 0, staleDown = 0, rejDown = 0, degraded = 0, p99add = 0, stalePass = callType ? 1 : 0;
      let tailSq = Math.pow(Math.max(0, own.p99 - own.p50), 2), p99med = 0;
      for (const x of outs) {
        const E = this.E(x.e);
        if (E.repl) continue; // replication is async (sync handled at the primary)
        if (E.async && (c === 'w' || n.type === 'queue')) continue;
        const intended = E.intended[c];
        if (intended <= 0) continue;
        const share = Math.min(callType ? 1 : 1, intended / servedC);
        const T = this.S(x.t);
        const tc = c; // same class downstream
        const d = T.e2e[tc];
        const extra = E.extraMs || 0;
        const timeout = callType ? p.timeoutMs : (n.type === 'client' ? p.timeoutMs : 0);
        const dl50 = d.p50 + extra, dl99 = d.p99 + extra;
        const pLat = timeoutProb(dl50, dl99, timeout);
        const errT = E.cut ? 1 : d.err;
        const pAttempt = 1 - (1 - errT) * (1 - pLat);
        const R = p.retries || 0;
        const pFinal = Math.pow(pAttempt, R + 1);
        const frac = E.frac;
        // A fallback covers any failed call to this dependency (breaker open,
        // timeout or error): the caller serves a degraded response instead.
        const fb = p.fallback && callType ? 1 : 0;
        const rawFail = (1 - frac) + frac * pFinal;
        const failShare = rawFail * (1 - fb);
        degraded += share * rawFail * fb;
        let l50 = timeout ? Math.min(dl50, timeout) : dl50;
        let l99 = timeout ? Math.min(dl99, timeout) : dl99;
        if (R > 0 && pAttempt > 0.01) { l99 = l99 * (1 + Math.min(R, Math.ceil(pAttempt * 10))); if (pAttempt > 0.5) l50 = l50 * (1 + R); }
        if (frac === 0) { l50 = 1; l99 = 2; }
        p50 += share * l50;
        // Sequential calls: medians add, but independent tails rarely align, so
        // tail excesses (p99 − p50) combine as a root-sum-square.
        if (share >= 0.01) {
          if (callType) { tailSq += Math.pow(Math.max(0, l99 - l50), 2); p99med += share * l50; }
          else p99add = Math.max(p99add, l99);
        }
        if (callType) errDown *= 1 - share * failShare; else errSum += share * failShare;
        const okShare = 1 - failShare;
        if (callType) stalePass *= 1 - share * okShare * d.stale; else staleDown += share * okShare * d.stale;
        rejDown += share * (d.rej || 0);
        // edge-level bookkeeping for retries / breakers / UI
        E.pa[c] = pAttempt;
        E.paW = (E.paW || 0) + intended * pAttempt;
        E.plW = (E.plW || 0) + intended * pLat;
        E.iW = (E.iW || 0) + intended;
        E.pFinal = pFinal;
        if (c === 'w' && R > 0 && !p.idempotency) E.dupRate = intended * pLat * (1 - errT);
        else if (c === 'w') E.dupRate = 0;
      }
      if (callType) p99 = own.p50 + p99med + Math.sqrt(tailSq);
      else p99 += p99add;
      const errFromDown = callType ? 1 - errDown : errSum;
      const err = clamp(ownErr + (1 - ownErr) * errFromDown, 0, 1);
      const ownStaleC = st.ownStale[c] || 0;
      let stale = callType ? 1 - stalePass : staleDown;
      // locally served share (cache hit) carries its own staleness
      stale = clamp(ownStaleC + stale, 0, 1);
      st.e2e[c] = { p50, p99, err, rej: clamp(rej0 + rejDown, 0, 1), stale, degraded };
    }
    // Flow-weighted view of each outgoing edge, for breakers and the UI.
    for (const x of outs) {
      const E = this.E(x.e);
      if (E.iW > 0) { E.pAttempt = E.paW / E.iW; E.pLat = E.plW / E.iW; }
      else if (E.cut || this.S(x.t).down) { E.pAttempt = 1; E.pLat = 0; }
      else { E.pAttempt = 0; E.pLat = 0; }
    }
    // Health endpoint view: a component whose requests almost all fail is "unhealthy".
    const loaded = total(st.served) + total(st.in) > 0;
    const failing = st.down || (loaded && Math.max(st.e2e.r.err, st.e2e.w.err, st.e2e.s.err) > 0.9 && CLS.every(c => st.in[c] <= 0 || st.e2e[c].err > 0.9));
    if (failing) { if (st.failingSince == null) st.failingSince = this.t; } else st.failingSince = null;
    // Downstream wait used next tick for thread-pool math (Little's law).
    if (callType) {
      const tot = total(st.served) || 1;
      let wsum = 0;
      for (const c of CLS) wsum += (st.served[c] / tot) * Math.max(0, st.e2e[c].p50 - st.lat[c].p50);
      st.downWaitMs = st.e2e && tot > 0 ? wsum : 0;
    }
  }

  updateEdges() {
    for (const e of this.graph.edges) {
      const E = this.E(e);
      const src = this._byId.get(e.from);
      if (!src) continue;
      const p = src.params;
      const R = p.retries || 0;
      if (R > 0) {
        // Each class is amplified by its own failure rate: failing writes
        // shouldn't make reads retry.
        for (const c of CLS) {
          const pa = E.pa[c] || 0;
          let extra = 0;
          for (let k = 1; k <= R; k++) extra += Math.pow(pa, k);
          if (p.backoff) extra *= 0.5;
          E.ampC[c] = E.ampC[c] * 0.7 + (1 + extra) * 0.3;
        }
        const f = E.intended, tot = total(f);
        E.amp = tot > 0 ? (f.r * E.ampC.r + f.w * E.ampC.w + f.s * E.ampC.s) / tot : 1;
      } else { E.amp = 1; E.ampC = { r: 1, w: 1, s: 1 }; }
      if (p.circuitBreaker && CALL_TYPES.has(src.type)) {
        const cb = E.cb;
        const tgt = this._byId.get(e.to);
        const tErr = tgt ? Math.max(this.S(tgt).e2e.r.err, this.S(tgt).e2e.w.err) : 0;
        const bad = E.cut || (tgt && this.S(tgt).down) || (total(E.intended) > 0 && (E.pAttempt || 0) > 0.5);
        if (cb.state === 'closed') {
          cb.badFor = bad ? cb.badFor + DT : 0;
          if (cb.badFor >= 1) { cb.state = 'open'; cb.since = this.t; this.say('good', `Circuit breaker OPEN on ${nm(src)} → ${nm(tgt)}: failing fast instead of piling up.`, src); }
        } else if (cb.state === 'open') {
          if (this.t - cb.since >= 5) { cb.state = 'half'; cb.since = this.t; }
        } else if (cb.state === 'half') {
          const probeBad = E.cut || (tgt && this.S(tgt).down) || tErr > 0.5 || (E.pAttempt || 0) > 0.5;
          if (this.t - cb.since >= 1) {
            if (probeBad) { cb.state = 'open'; cb.since = this.t; }
            else { cb.state = 'ramp'; cb.since = this.t; }
          }
        } else if (cb.state === 'ramp') {
          // Slow start: let traffic back in gradually so a recovering dependency
          // isn't flattened by the full load the moment the breaker closes.
          if (bad) { cb.state = 'open'; cb.since = this.t; }
          else if (this.t - cb.since >= 5) { cb.state = 'closed'; cb.badFor = 0; this.say('good', `Circuit breaker CLOSED on ${nm(src)} → ${nm(tgt)}: dependency healthy again.`, src); }
        }
      } else { E.cb.state = 'closed'; E.cb.badFor = 0; }
    }
  }

  postTick() {
    for (const n of this.graph.nodes) {
      const st = this.S(n);
      const p = n.params;
      // Hot keys refill within seconds under load; the long tail takes longer.
      if (n.type === 'cache' && !st.down && st.warmth < 1) st.warmth = Math.min(1, st.warmth + (1 - st.warmth) * DT / 6 + DT / 60);
      if ((n.type === 'app' || n.type === 'worker') && p.autoscale && !st.down) this.autoscale(n, st, p);
    }
  }

  autoscale(n, st, p) {
    // boot pending instances
    const ready = st.pending.filter(x => x <= this.t).length;
    if (ready) { st.instances += ready; st.pending = st.pending.filter(x => x > this.t); this.say('info', `${nm(n)}: ${ready} new instance(s) finished booting (${st.instances} running).`, n); }
    if (st.instances < p.minInstances && !st.pending.length) st.instances = p.minInstances;
    if (st.instances > p.maxInstances) st.instances = p.maxInstances;
    if (this.t - st.lastScale < 3) return;
    // Target tracking on demand: how many instances would run at the target
    // utilization for the load arriving right now?
    const size = COMPUTE_SIZES[p.size] || COMPUTE_SIZES.S;
    const perInst = Math.min(size.cap, size.threads / Math.max(1e-3, st.holdMs / 1000));
    const demand = total(st.in) + st.backlog / 5;
    const target = p.targetCpu / 100;
    const desired = clamp(Math.ceil(demand / (perInst * target)), p.minInstances, p.maxInstances);
    const planned = st.instances + st.pending.length;
    if (desired > planned) {
      const add = desired - planned;
      for (let i = 0; i < add; i++) st.pending.push(this.t + p.bootSec);
      st.lastScale = this.t;
      this.say('info', `${nm(n)}: autoscaler adding ${add} instance(s); ready in ${p.bootSec}s.`, n);
    } else if (desired < st.instances && !st.pending.length) {
      // Scale in more gently than out: at most ~20% per step, to avoid flapping.
      const remove = Math.max(1, Math.min(st.instances - desired, Math.floor(st.instances * 0.2)));
      st.instances -= remove;
      st.lastScale = this.t;
    }
  }

  // ---------- metrics ----------
  collect() {
    const m = blankMetrics();
    let off = 0, err = 0, rej = 0, p50w = 0, reads = 0, stale = 0, writes = 0, degraded = 0;
    const clients = this.graph.nodes.filter(n => n.type === 'client');
    let p99 = 0;
    for (const n of clients) {
      const st = this.S(n);
      const o = st.offered;
      const tot = total(o);
      if (tot <= 0) continue;
      const noRoute = !this.outEdges(n).length;
      for (const c of CLS) {
        if (o[c] <= 0) continue;
        const e = noRoute ? { p50: 0, p99: 0, err: 1, rej: 0, stale: 0, degraded: 0 } : st.e2e[c];
        off += o[c];
        err += o[c] * e.err;
        rej += o[c] * Math.min(e.rej, 1 - e.err);
        degraded += o[c] * (e.degraded || 0);
        p50w += o[c] * e.p50;
        if (c === 'r') { reads += o[c]; stale += o[c] * e.stale; }
        if (c === 'w') writes += o[c];
        if (o[c] / tot >= 0.01) p99 = Math.max(p99, e.p99);
      }
    }
    m.offered = off;
    m.errRate = off ? err / off : 0;
    m.rejRate = off ? rej / off : 0;
    m.okRate = 1 - m.errRate - m.rejRate;
    m.goodput = off * m.okRate;
    m.p50 = off ? p50w / off : 0;
    m.p99 = p99;
    m.staleRate = reads ? stale / reads : 0;
    m.degradedRate = off ? degraded / off : 0;
    m.writeRps = writes;
    // cost
    let cost = 0;
    const kb = this.ctx().staticKB;
    for (const n of this.graph.nodes) {
      const st = this.S(n);
      const inst = (n.type === 'app' || n.type === 'worker') ? st.instances + st.pending.length : null;
      cost += nodeCost(n, inst);
      const gbPerMonth = rps => (rps * 86400 * 30 * kb) / 1e6;
      if (n.type === 'cdn') cost += gbPerMonth(st.in.s) * 0.03;
      if ((n.type === 'blob' || n.type === 'app') && st.served.s > 0) cost += gbPerMonth(st.served.s) * 0.09;
    }
    m.cost = cost;
    let maxLag = 0, maxUtil = 0, dup = 0;
    for (const n of this.graph.nodes) {
      const st = this.S(n);
      if (n.type === 'queue') maxLag = Math.max(maxLag, st.qlag || 0);
      if (n.type !== 'client') maxUtil = Math.max(maxUtil, st.util || 0);
    }
    for (const e of this.graph.edges) dup += this.E(e).dupRate || 0;
    m.consumerLag = maxLag;
    m.maxUtil = maxUtil;
    m.dupRate = dup;
    this.totals.duplicates += dup * DT;
    this.totals.requests += off * DT;
    this.totals.failed += off * m.errRate * DT;
    this.totals.costSum = (this.totals.costSum || 0) + cost;
    this.totals.ticks = (this.totals.ticks || 0) + 1;
    m.availability = this.totals.requests ? 1 - this.totals.failed / this.totals.requests : 1;
    m.avgCost = this.totals.costSum / this.totals.ticks;
    m.lostWrites = this.totals.lostWrites;
    m.duplicates = this.totals.duplicates;
    m.t = this.t;
    this.metrics = m;
    if (this.tick % 5 === 0) {
      this.history.push({ ...m });
      if (this.history.length > 1200) this.history.shift();
    }
  }

  // Rolling average of the last `sec` seconds of samples.
  rolling(sec = 3) {
    const k = Math.max(1, Math.round(sec / (5 * DT)));
    const h = this.history.slice(-k);
    if (!h.length) return this.metrics;
    const avg = {};
    for (const key of Object.keys(h[0])) avg[key] = h.reduce((a, x) => a + (x[key] || 0), 0) / h.length;
    avg.lostWrites = this.metrics.lostWrites;
    avg.duplicates = this.metrics.duplicates;
    avg.availability = this.metrics.availability;
    avg.avgCost = this.metrics.avgCost;
    avg.t = this.t;
    return avg;
  }
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function lcm(a, b) { return (a * b) / gcd(a, b); }
function blankE2E() { return { p50: 0, p99: 0, err: 0, rej: 0, stale: 0, degraded: 0 }; }
function blankMetrics() { return { offered: 0, goodput: 0, okRate: 1, errRate: 0, rejRate: 0, p50: 0, p99: 0, staleRate: 0, cost: 0, consumerLag: 0, maxUtil: 0, dupRate: 0, duplicates: 0, lostWrites: 0, writeRps: 0, degradedRate: 0, t: 0 }; }

export function statusOf(st) {
  if (st.down) return 'down';
  const u = Math.max(st.util || 0, st.threadUtil || 0);
  if (st.dropFrac > 0.001 || u >= 0.95) return 'saturated';
  if (u >= 0.7) return 'stressed';
  if (u <= 0 && !st.in) return 'idle';
  return 'healthy';
}

export function nm(n) { return n ? (n.label || CATALOG[n.type]?.label || n.type) : '?'; }
export function fmtInt(x) { return Math.round(x).toLocaleString('en-US'); }
