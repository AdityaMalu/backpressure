// Free-form drag-and-drop architecture editor with live traffic animation.

import { CATALOG, CATEGORIES, withDefaults, COMPUTE_SIZES } from './catalog.js';
import { statusOf } from './engine.js';

const NODE_W = 184;
const SVGNS = 'http://www.w3.org/2000/svg';
const OFF = 5000; // svg offset so edges can live at negative coordinates

export const fmtRps = x => (x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e4 ? Math.round(x / 1e3) + 'k' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : x >= 10 ? Math.round(x) + '' : x > 0 ? x.toFixed(1) : '0');
export const fmtMs = x => (x >= 10000 ? (x / 1000).toFixed(0) + 's' : x >= 1000 ? (x / 1000).toFixed(1) + 's' : Math.round(x) + 'ms');
const STATUS_LABEL = { healthy: 'HEALTHY', stressed: 'STRESSED', saturated: 'SATURATED', down: 'DOWN', idle: 'IDLE' };
const CLASS_COLOR = { r: '#38bdf8', w: '#fbbf24', s: '#a78bfa' };

let uid = 0;
export const newId = prefix => `${prefix}${Date.now().toString(36)}${(uid++).toString(36)}`;

export class Editor {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.view = { x: 60, y: 40, k: 1 };
    this.particles = new Map();
    this.nodeEls = new Map();
    this.edgeEls = new Map();
    this.heights = new Map();
    this.build();
  }

  get graph() { return this.app.graph; }

  build() {
    this.root.innerHTML = `
      <div class="viewport">
        <div class="grid-bg"></div>
        <div class="world">
          <svg class="edges" width="${OFF * 2}" height="${OFF * 2}" style="left:${-OFF}px;top:${-OFF}px">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,1 L9,5 L0,9 z" fill="#5b7bb0"/></marker>
            </defs>
            <g class="edge-layer" transform="translate(${OFF},${OFF})"></g>
            <g class="temp-layer" transform="translate(${OFF},${OFF})"></g>
          </svg>
          <div class="node-layer"></div>
          <div class="callout-layer"></div>
        </div>
        <canvas class="particles"></canvas>
        <div class="canvas-hint"></div>
        <div class="zoom-ctl">
          <button data-z="in" title="Zoom in">+</button>
          <button data-z="out" title="Zoom out">−</button>
          <button data-z="fit" title="Fit to screen">⤢</button>
        </div>
      </div>`;
    this.vp = this.root.querySelector('.viewport');
    this.world = this.root.querySelector('.world');
    this.edgeLayer = this.root.querySelector('.edge-layer');
    this.tempLayer = this.root.querySelector('.temp-layer');
    this.nodeLayer = this.root.querySelector('.node-layer');
    this.calloutLayer = this.root.querySelector('.callout-layer');
    this.canvas = this.root.querySelector('canvas.particles');
    this.hint = this.root.querySelector('.canvas-hint');
    this.ctx2d = this.canvas.getContext('2d');
    this.bindViewport();
    this.root.querySelector('.zoom-ctl').addEventListener('click', e => {
      const z = e.target.dataset.z;
      if (z === 'in') this.zoomAt(this.vp.clientWidth / 2, this.vp.clientHeight / 2, 1.2);
      if (z === 'out') this.zoomAt(this.vp.clientWidth / 2, this.vp.clientHeight / 2, 1 / 1.2);
      if (z === 'fit') this.fit();
    });
    new ResizeObserver(() => this.resizeCanvas()).observe(this.vp);
    this.resizeCanvas();
  }

  resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.vp.clientWidth * dpr;
    this.canvas.height = this.vp.clientHeight * dpr;
    this.canvas.style.width = this.vp.clientWidth + 'px';
    this.canvas.style.height = this.vp.clientHeight + 'px';
    this.dpr = dpr;
  }

  applyView() {
    const { x, y, k } = this.view;
    this.world.style.transform = `translate(${x}px,${y}px) scale(${k})`;
    const bg = this.root.querySelector('.grid-bg');
    bg.style.backgroundSize = `${24 * k}px ${24 * k}px`;
    bg.style.backgroundPosition = `${x}px ${y}px`;
  }

  toWorld(cx, cy) {
    const r = this.vp.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.k, y: (cy - r.top - this.view.y) / this.view.k };
  }

  zoomAt(sx, sy, f) {
    const k = Math.max(0.3, Math.min(2.2, this.view.k * f));
    const wx = (sx - this.view.x) / this.view.k, wy = (sy - this.view.y) / this.view.k;
    this.view.k = k;
    this.view.x = sx - wx * k;
    this.view.y = sy - wy * k;
    this.applyView();
  }

  fit() {
    const ns = this.graph.nodes;
    if (!ns.length) { this.view = { x: 60, y: 40, k: 1 }; this.applyView(); return; }
    const minX = Math.min(...ns.map(n => n.x)), maxX = Math.max(...ns.map(n => n.x + NODE_W));
    const minY = Math.min(...ns.map(n => n.y)), maxY = Math.max(...ns.map(n => n.y + 110));
    // Leave room for the palette overlay (left) and the KPI strip (bottom).
    const pal = document.querySelector('.palette');
    const left = pal && !pal.classList.contains('collapsed') ? pal.offsetWidth + 24 : 48;
    const top = 30, bottom = 80, right = 40;
    const W = this.vp.clientWidth - left - right, H = this.vp.clientHeight - top - bottom;
    const k = Math.max(0.3, Math.min(1.1, Math.min(W / (maxX - minX + 1), H / (maxY - minY + 1))));
    this.view.k = k;
    this.view.x = left + (W - (maxX - minX) * k) / 2 - minX * k;
    this.view.y = top + (H - (maxY - minY) * k) / 2 - minY * k;
    this.applyView();
  }

  bindViewport() {
    const vp = this.vp;
    vp.addEventListener('wheel', e => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (e.ctrlKey || Math.abs(e.deltaY) > 0 && !e.shiftKey) this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    // Two-finger pinch zoom (touch screens).
    this.pointers = new Map();
    vp.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); }, true);
    const lift = e => { this.pointers.delete(e.pointerId); if (this.pointers.size < 2) this.pinch = null; };
    window.addEventListener('pointerup', lift, true);
    window.addEventListener('pointercancel', lift, true);
    vp.addEventListener('pointermove', e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size !== 2) return;
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = vp.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      if (this.pinch) this.zoomAt(cx, cy, d / this.pinch);
      this.pinch = d;
    });

    vp.addEventListener('pointerdown', e => {
      if (e.button === 2) return;
      if (this.pointers.size > 1) return;
      const port = e.target.closest('.port.out');
      const nodeEl = e.target.closest('.node');
      const edgeHit = e.target.closest('.edge-hit');
      const callout = e.target.closest('.callout');
      if (callout) { this.app.select({ kind: 'node', id: callout.dataset.node }); return; }
      if (port && nodeEl) return this.startConnect(e, nodeEl.dataset.id);
      if (nodeEl) return this.startDrag(e, nodeEl.dataset.id);
      if (edgeHit) { this.app.select({ kind: 'edge', id: edgeHit.dataset.id }); return; }
      if (e.target.closest('.zoom-ctl')) return;
      this.startPan(e);
    });

    vp.addEventListener('contextmenu', e => {
      const nodeEl = e.target.closest('.node');
      const edgeHit = e.target.closest('.edge-hit');
      if (nodeEl || edgeHit) {
        e.preventDefault();
        const sel = nodeEl ? { kind: 'node', id: nodeEl.dataset.id } : { kind: 'edge', id: edgeHit.dataset.id };
        this.app.select(sel);
        this.app.openContextMenu(sel, e.clientX, e.clientY);
      }
    });

    vp.addEventListener('dblclick', e => {
      const nodeEl = e.target.closest('.node');
      if (nodeEl) this.app.select({ kind: 'node', id: nodeEl.dataset.id }, true);
    });
  }

  startPan(e) {
    const sx = e.clientX, sy = e.clientY, ox = this.view.x, oy = this.view.y;
    let moved = false;
    const mv = ev => {
      if (this.pointers.size > 1) { moved = true; return; } // pinching, not panning
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true;
      this.view.x = ox + ev.clientX - sx; this.view.y = oy + ev.clientY - sy; this.applyView();
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (!moved) this.app.select(null); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  startDrag(e, id) {
    const n = this.graph.nodes.find(x => x.id === id);
    if (!n) return;
    const start = this.toWorld(e.clientX, e.clientY);
    const ox = n.x, oy = n.y;
    let moved = false;
    const mv = ev => {
      const w = this.toWorld(ev.clientX, ev.clientY);
      const dx = w.x - start.x, dy = w.y - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      n.x = Math.round((ox + dx) / 8) * 8; n.y = Math.round((oy + dy) / 8) * 8;
      const el = this.nodeEls.get(id);
      if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
      this.renderEdges();
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      if (moved) this.app.commit('move', true);
      else this.app.select({ kind: 'node', id });
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  startConnect(e, fromId) {
    e.stopPropagation();
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'edge-temp');
    this.tempLayer.appendChild(path);
    const from = this.anchorOut(this.graph.nodes.find(n => n.id === fromId));
    this.vp.classList.add('connecting');
    const mv = ev => {
      const w = this.toWorld(ev.clientX, ev.clientY);
      path.setAttribute('d', bezier(from, w));
      document.querySelectorAll('.node.drop-target').forEach(x => x.classList.remove('drop-target'));
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
      if (over && over.dataset.id !== fromId) over.classList.add('drop-target');
    };
    const up = ev => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      path.remove();
      this.vp.classList.remove('connecting');
      document.querySelectorAll('.node.drop-target').forEach(x => x.classList.remove('drop-target'));
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
      if (over && over.dataset.id !== fromId) this.app.connect(fromId, over.dataset.id);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  anchorOut(n) { return { x: n.x + NODE_W, y: n.y + (this.heights.get(n.id) || 96) / 2 }; }
  anchorIn(n) { return { x: n.x, y: n.y + (this.heights.get(n.id) || 96) / 2 }; }

  // ---------- rendering ----------
  render() {
    const g = this.graph;
    const ids = new Set(g.nodes.map(n => n.id));
    for (const [id, el] of this.nodeEls) if (!ids.has(id)) { el.remove(); this.nodeEls.delete(id); }
    for (const n of g.nodes) {
      let el = this.nodeEls.get(n.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'node';
        el.dataset.id = n.id;
        el.innerHTML = `
          <div class="node-head"><span class="ico"></span><span class="name"></span></div>
          <div class="node-sub"></div>
          <div class="node-status"><span class="badge">IDLE</span><span class="metric-a"></span></div>
          <div class="node-bar"><i></i></div>
          <div class="node-stats"><span class="s1"></span><span class="s2"></span></div>
          <div class="port in" title="Input"></div>
          <div class="port out" title="Drag to connect"></div>`;
        this.nodeLayer.appendChild(el);
        this.nodeEls.set(n.id, el);
      }
      const def = CATALOG[n.type];
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      el.style.setProperty('--accent', def.color);
      el.querySelector('.ico').textContent = def.icon;
      el.querySelector('.name').textContent = n.label || def.label;
      el.querySelector('.node-sub').textContent = subtitle(n);
      el.classList.toggle('selected', this.app.selected?.kind === 'node' && this.app.selected.id === n.id);
      el.classList.toggle('is-client', n.type === 'client');
    }
    for (const n of g.nodes) { const el = this.nodeEls.get(n.id); if (el) this.heights.set(n.id, el.offsetHeight || 96); }
    this.renderEdges(true);
    this.hint.style.display = g.nodes.length ? 'none' : 'flex';
    this.hint.innerHTML = '<div><b>Empty canvas</b><br>Drag components from the left palette.<br>Connect them by dragging from the ● on a node’s right edge.</div>';
  }

  renderEdges(full) {
    const g = this.graph;
    const ids = new Set(g.edges.map(e => e.id));
    for (const [id, grp] of this.edgeEls) if (!ids.has(id)) { grp.g.remove(); this.edgeEls.delete(id); this.particles.delete(id); }
    const byId = new Map(g.nodes.map(n => [n.id, n]));
    for (const e of g.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      let grp = this.edgeEls.get(e.id);
      if (!grp) {
        const gEl = document.createElementNS(SVGNS, 'g');
        gEl.setAttribute('class', 'edge');
        const hit = document.createElementNS(SVGNS, 'path');
        hit.setAttribute('class', 'edge-hit');
        hit.dataset.id = e.id;
        const line = document.createElementNS(SVGNS, 'path');
        line.setAttribute('class', 'edge-line');
        line.setAttribute('marker-end', 'url(#arrow)');
        const label = document.createElementNS(SVGNS, 'text');
        label.setAttribute('class', 'edge-label');
        gEl.append(hit, line, label);
        this.edgeLayer.appendChild(gEl);
        grp = { g: gEl, hit, line, label };
        this.edgeEls.set(e.id, grp);
      }
      const p1 = this.anchorOut(a), p2 = this.anchorIn(b);
      const d = bezier(p1, p2);
      grp.hit.setAttribute('d', d);
      grp.line.setAttribute('d', d);
      grp.p = [p1, p2];
      const mid = bezPoint(p1, p2, 0.5);
      grp.label.setAttribute('x', mid.x);
      grp.label.setAttribute('y', mid.y - 7);
      grp.g.classList.toggle('selected', this.app.selected?.kind === 'edge' && this.app.selected.id === e.id);
    }
  }

  // Called every animation frame with the live simulation.
  updateLive(sim, dtReal, running, insights) {
    const g = this.graph;
    for (const n of g.nodes) {
      const el = this.nodeEls.get(n.id);
      if (!el) continue;
      const st = sim.ns.get(n.id);
      const status = st ? (n.type === 'client' ? 'client' : st.status) : 'idle';
      if (el.dataset.status !== status) {
        el.dataset.status = status;
        el.querySelector('.badge').textContent = n.type === 'client' ? 'TRAFFIC' : (STATUS_LABEL[status] || 'IDLE');
      }
      if (!st) continue;
      const tot = st.in.r + st.in.w + st.in.s + (st.inRepl || 0);
      const [a, s1, s2, bar] = nodeReadout(n, st, sim);
      el.querySelector('.metric-a').textContent = a;
      el.querySelector('.s1').textContent = s1;
      el.querySelector('.s2').textContent = s2;
      const b = el.querySelector('.node-bar i');
      b.style.width = Math.min(100, bar * 100) + '%';
      b.dataset.level = bar >= 0.95 ? 'hi' : bar >= 0.7 ? 'mid' : 'lo';
      el.classList.toggle('active', tot > 0);
      el.querySelector('.node-sub').textContent = subtitle(n, st);
    }
    // edges
    for (const e of g.edges) {
      const grp = this.edgeEls.get(e.id);
      const E = sim.es.get(e.id);
      if (!grp || !E) continue;
      const f = E.flow.r + E.flow.w + E.flow.s;
      const failing = E.cut || (E.pAttempt || 0) > 0.25 || (E.cb && E.cb.state === 'open');
      const w = f > 0 ? Math.min(6, 1.2 + Math.log10(1 + f) * 0.9) : 1.2;
      grp.line.style.strokeWidth = w;
      grp.g.dataset.state = E.cut ? 'cut' : failing && f > 0 ? 'fail' : E.cb?.state === 'open' ? 'open' : f > 0 ? 'live' : 'idle';
      grp.g.classList.toggle('async', !!(E.async || E.repl));
      grp.label.textContent = E.cb?.state === 'open' ? 'circuit open' : E.cut ? '✂ partitioned' : f > 0 ? fmtRps(f) + (E.repl ? ' repl/s' : ' rps') + (E.amp > 1.05 ? ` (×${E.amp.toFixed(1)} retries)` : '') : '';
    }
    this.renderCallouts(insights);
    this.drawParticles(sim, dtReal, running);
  }

  renderCallouts(insights) {
    const seen = new Set();
    const items = [];
    for (const it of insights || []) {
      if (!it.node || seen.has(it.node) || (it.sev !== 'bad' && it.sev !== 'good')) continue;
      seen.add(it.node);
      items.push(it);
      if (items.length >= 3) break;
    }
    const { x: vx, y: vy, k } = this.view;
    const W = this.vp.clientWidth;
    const key = items.map(i => i.node + i.title + i.text).join('|') + `|${Math.round(vx)},${Math.round(vy)},${k.toFixed(2)},${W}`;
    if (key === this._calloutKey) return;
    this._calloutKey = key;
    this.calloutLayer.innerHTML = '';
    for (const it of items) {
      const n = this.graph.nodes.find(x => x.id === it.node);
      if (!n) continue;
      const div = document.createElement('div');
      div.className = 'callout sev-' + it.sev;
      div.dataset.node = n.id;
      // Prefer the top-right of the node; flip left if that would leave the screen.
      const rightEdge = (n.x + NODE_W - 20 + 240) * k + vx;
      div.style.left = (rightEdge > W - 8 ? n.x - 210 : n.x + NODE_W - 20) + 'px';
      div.style.top = (n.y - 64) + 'px';
      div.innerHTML = `<b>${it.sev === 'bad' ? '⚠' : '✓'} ${esc(it.title)}</b><span>${esc(it.text)}</span>`;
      this.calloutLayer.appendChild(div);
    }
  }

  drawParticles(sim, dtReal, running) {
    const c = this.ctx2d;
    const { x: vx, y: vy, k } = this.view;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const e of this.graph.edges) {
      const grp = this.edgeEls.get(e.id);
      const E = sim.es.get(e.id);
      if (!grp || !E || !grp.p) continue;
      let list = this.particles.get(e.id);
      if (!list) { list = []; this.particles.set(e.id, list); list.acc = 0; }
      const f = E.flow;
      const tot = f.r + f.w + f.s;
      if (running) {
        const rate = tot > 0 ? Math.min(14, 1.5 + Math.log10(1 + tot) * 2.4) : 0;
        list.acc += rate * dtReal;
        while (list.acc >= 1) {
          list.acc -= 1;
          const roll = Math.random() * tot;
          const cls = roll < f.r ? 'r' : roll < f.r + f.w ? 'w' : 's';
          const fail = E.cut || Math.random() < Math.min(0.95, E.pAttempt || 0);
          list.push({ t: 0, cls, fail, speed: 0.55 + Math.random() * 0.25, jitter: (Math.random() - 0.5) * 6 });
        }
        for (const p of list) p.t += p.speed * dtReal * (E.async || E.repl ? 0.6 : 1);
        while (list.length && list[0].t >= 1) list.shift();
        if (list.length > 40) list.splice(0, list.length - 40);
      }
      const [p1, p2] = grp.p;
      for (const p of list) {
        let t = p.t;
        if (p.fail && t > 0.75) continue; // failing requests die before arriving
        const pt = bezPoint(p1, p2, t);
        const sx = pt.x * k + vx, sy = (pt.y + p.jitter) * k + vy;
        const col = p.fail ? '#ef4444' : CLASS_COLOR[p.cls];
        c.beginPath();
        c.fillStyle = col;
        c.shadowColor = col;
        c.shadowBlur = 8;
        c.arc(sx, sy, Math.max(1.6, 2.6 * k), 0, Math.PI * 2);
        c.fill();
      }
    }
    c.shadowBlur = 0;
  }
}

export function makeNode(type, x, y, params, label) {
  return { id: newId(type.slice(0, 3)), type, x, y, label: label || '', params: withDefaults(type, params) };
}

function subtitle(n, st) {
  const p = n.params;
  switch (n.type) {
    case 'client': return `${fmtRps(p.rps)} rps · ${Math.round(p.readRatio * 100)}% reads · ${p.pattern}`;
    case 'app': case 'worker': {
      const live = st ? st.instances : p.instances;
      const pend = st && st.pending.length ? ` (+${st.pending.length} booting)` : '';
      return `${live}× ${p.size}${pend}${p.autoscale ? ' · auto' : ''}${p.circuitBreaker ? ' · CB' : ''}`;
    }
    case 'sqldb': return `${p.size} · ${p.replication} repl${p.indexed ? '' : ' · NO INDEX'}`;
    case 'replica': return `${p.size} · read-only`;
    case 'cache': return `${p.memoryGB}GB × ${p.nodes} · ${p.strategy} · TTL ${p.ttlSec}s`;
    case 'lb': return `${p.algorithm}${p.healthChecks ? ' · health checks' : ' · NO health checks'}`;
    case 'gateway': return p.rateLimit ? `limit ${fmtRps(p.limitRps)}/s · ${p.algorithm}` : 'no rate limit';
    case 'cdn': return `static hit ${Math.round(p.staticHit * 100)}%${p.cacheApi ? ` · API ${Math.round(p.apiHit * 100)}%` : ''}`;
    case 'nosql': return `${p.nodes} nodes · RF${p.rf} · ${p.consistency}`;
    case 'shard': return `${p.shards} shards · ${p.partitioning}`;
    case 'queue': return `${p.partitions} partitions · ${p.mode === 'pub-sub' ? 'pub/sub' : 'competing'}`;
    case 'dns': return `${p.mode} · TTL ${p.ttl}s`;
    case 'external': return `${p.latencyMs}ms · quota ${fmtRps(p.quotaRps)}/s`;
    case 'blob': return 'S3-compatible';
    default: return '';
  }
}

function nodeReadout(n, st, sim) {
  const tot = st.in.r + st.in.w + st.in.s;
  const util = Math.max(st.util || 0, st.threadUtil || 0);
  const e2e = st.e2e;
  const p99 = Math.max(st.lat.r.p99, st.lat.w.p99, st.lat.s.p99);
  switch (n.type) {
    case 'client': {
      const m = sim.metrics;
      return [`${fmtRps(m.offered)} rps`, `ok ${(m.okRate * 100).toFixed(1)}%`, `p99 ${fmtMs(m.p99)}`, 0];
    }
    case 'app': case 'worker':
      return [`CPU ${Math.round(st.cpu * 100)}%`, `${fmtRps(tot)} rps`, `p99 ${fmtMs(p99)}`, util];
    case 'cache':
      return [`hit ${Math.round(st.hit * 100)}%`, `${fmtRps(tot)} ops`, `p99 ${fmtMs(p99)}`, util];
    case 'cdn':
      return [`hit ${Math.round((st.hit || 0) * 100)}%`, `${fmtRps(tot)} rps`, `edge ${fmtMs(5)}`, 0];
    case 'queue':
      return [`lag ${fmtMs((st.qlag || 0) * 1000)}`, `${fmtRps(tot)} in`, `${fmtRps(st.consumeRate || 0)} out`, Math.min(1, (st.qlag || 0) / 30)];
    case 'replica':
      return [`lag ${fmtMs((st.lag || 0) * 1000)}`, `${fmtRps(tot)} reads`, `p99 ${fmtMs(p99)}`, util];
    case 'gateway':
      return [`429 ${Math.round((st.rejFrac || 0) * 100)}%`, `${fmtRps(tot)} rps`, `p99 ${fmtMs(p99)}`, util];
    case 'external':
      return [`err ${((e2e.w.err || e2e.r.err || 0) * 100).toFixed(1)}%`, `${fmtRps(tot)} rps`, `p99 ${fmtMs(p99)}`, util];
    case 'shard': case 'nosql':
      return [`load ${Math.round(util * 100)}%`, `${fmtRps(tot)} ops`, `p99 ${fmtMs(p99)}`, util];
    default:
      return [`load ${Math.round(util * 100)}%`, `${fmtRps(tot)} rps`, `p99 ${fmtMs(p99)}`, util];
  }
}

function bezier(a, b) {
  const dx = Math.max(50, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}
function bezPoint(a, b, t) {
  const dx = Math.max(50, Math.abs(b.x - a.x) * 0.5);
  const p0 = a, p1 = { x: a.x + dx, y: a.y }, p2 = { x: b.x - dx, y: b.y }, p3 = b;
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}
export function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
export { NODE_W, CATEGORIES, COMPUTE_SIZES };
