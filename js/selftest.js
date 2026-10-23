// Headless lab verification: every starter should fail, every solution pass.
// Usage (browser console): (await import('./js/selftest.js')).runAll()
import { Simulation } from './engine.js';
import { LESSONS } from './curriculum/index.js';

const cmp = (v, op, t) => { if (v == null || !isFinite(v)) v = 0; return op === '<' ? v < t : op === '<=' ? v <= t : op === '>' ? v > t : v >= t; };

export function runLab(lab, graph) {
  const sim = new Simulation(JSON.parse(JSON.stringify(graph)), lab);
  const goals = lab.goals.map(g => ({ ...g, failed: false }));
  const dur = lab.duration || 60;
  while (sim.t < dur - 1e-9) {
    sim.step();
    if (sim.tick % 5) continue;
    const m = sim.rolling(3);
    for (const g of goals) {
      if (g.at === 'end' || sim.t < (g.after ?? 8)) continue;
      if (!g.failed && !cmp(m[g.metric], g.op, g.value)) { g.failed = true; g.at_ = sim.t.toFixed(1); g.v = m[g.metric]; }
    }
  }
  const m = sim.rolling(3);
  for (const g of goals) if (g.at === 'end') { g.v = m[g.metric]; g.failed = !cmp(g.v, g.op, g.value); }
  const worst = {};
  for (const h of sim.history) for (const k of ['p99', 'errRate', 'cost', 'staleRate', 'consumerLag']) worst[k] = Math.max(worst[k] || 0, h[k]);
  return { pass: goals.every(g => !g.failed), failed: goals.filter(g => g.failed).map(g => `${g.metric} ${g.op} ${g.value} broke@${g.at_ ?? 'end'} v=${fmt(g.v)}`), worst: Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, fmt(v)])), final: { p99: fmt(m.p99), err: fmt(m.errRate), cost: fmt(m.cost), avail: fmt(m.availability), avgCost: fmt(m.avgCost), stale: fmt(m.staleRate), lag: fmt(m.consumerLag) } };
}
const fmt = v => (v == null ? v : Math.abs(v) < 1 ? +v.toFixed(4) : Math.round(v));

// Timeline of a lab run: metrics plus the busiest/failing nodes every `every` seconds.
export function timeline(id, which = 'solution', every = 5) {
  const L = LESSONS.find(l => l.id === id);
  const sim = new Simulation(JSON.parse(JSON.stringify(which === 'solution' ? L.lab.solution : L.lab.graph)), L.lab);
  const rows = [];
  while (sim.t < (L.lab.duration || 60) - 1e-9) {
    sim.step();
    if (sim.tick % Math.round(every / 0.1)) continue;
    const m = sim.metrics;
    const nodes = sim.graph.nodes.filter(n => n.type !== 'client').map(n => { const s = sim.ns.get(n.id); return `${n.id}:${s.down ? 'DOWN' : Math.round(Math.max(s.util, s.threadUtil || 0) * 100) + '%'}${s.dropFrac > 0.01 ? ' drop' + Math.round(s.dropFrac * 100) : ''}${Math.max(s.e2e.r.err, s.e2e.w.err) > 0.01 ? ' err' + Math.round(Math.max(s.e2e.r.err, s.e2e.w.err) * 100) : ''}`; });
    rows.push(`${sim.t.toFixed(0)}s off=${Math.round(m.offered)} err=${(m.errRate * 100).toFixed(1)}% p99=${Math.round(m.p99)} stale=${(m.staleRate * 100).toFixed(1)}% | ${nodes.join(' ')}`);
  }
  return rows.join('\n') + '\nLOG:\n' + sim.log.map(l => `${l.t.toFixed(1)} ${l.text}`).join('\n');
}

export function runAll(filter) {
  const out = [];
  for (const L of LESSONS) {
    if (!L.lab || (filter && !L.id.includes(filter))) continue;
    const s = runLab(L.lab, L.lab.graph);
    const sol = L.lab.solution ? runLab(L.lab, L.lab.solution) : null;
    out.push({ id: L.id, starterFails: !s.pass, solutionPasses: sol ? sol.pass : null, starter: s, solution: sol });
  }
  return out;
}
