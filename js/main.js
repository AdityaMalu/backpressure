import { Simulation, DT, nm } from './engine.js';
import { CATALOG, CATEGORIES, REGIONS, withDefaults } from './catalog.js';
import { Editor, makeNode, newId, fmtRps, fmtMs, esc } from './editor.js';
import { diagnose } from './insights.js';
import { md } from './md.js';
import { lineChart } from './charts.js';
import { store, encodeDesign, decodeDesign } from './storage.js';
import { COURSE, LESSONS, findLesson, TEMPLATES } from './curriculum/index.js';
import { renderCalculator } from './calculator.js';

const $ = (s, r = document) => r.querySelector(s);
const pct = x => (x == null || !isFinite(x) ? '–' : (x * 100 >= 10 || x === 0 ? Math.round(x * 100) : (x * 100).toFixed(x * 100 >= 1 ? 1 : 2)) + '%');
const usd = x => '$' + (x >= 10000 ? Math.round(x / 1000) + 'k' : Math.round(x).toLocaleString('en-US'));
const secs = x => (x >= 60 ? (x / 60).toFixed(1) + 'm' : x >= 10 ? Math.round(x) + 's' : x.toFixed(1) + 's');
const clone = o => JSON.parse(JSON.stringify(o));
// Structural fingerprint (ignores positions, labels, defaulted params) used to
// tell whether the learner is running the unmodified reference solution.
const fingerprint = g => JSON.stringify({
  n: g.nodes.map(n => [n.id, n.type, withDefaults(n.type, n.params)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  e: g.edges.map(e => e.from + '>' + e.to).sort(),
});

export const METRICS = {
  p99: { label: 'p99 latency', fmt: fmtMs },
  p50: { label: 'p50 latency', fmt: fmtMs },
  errRate: { label: 'Error rate', fmt: pct },
  rejRate: { label: 'Rejected (429)', fmt: pct },
  okRate: { label: 'Success rate', fmt: pct },
  staleRate: { label: 'Stale reads', fmt: pct },
  cost: { label: 'Cost / month', fmt: usd },
  consumerLag: { label: 'Consumer lag', fmt: x => secs(x) },
  dupRate: { label: 'Duplicate writes/s', fmt: x => x.toFixed(1) },
  duplicates: { label: 'Duplicate writes', fmt: x => Math.round(x).toLocaleString() },
  lostWrites: { label: 'Lost writes', fmt: x => Math.round(x).toLocaleString() },
  goodput: { label: 'Successful rps', fmt: x => fmtRps(x) },
  maxUtil: { label: 'Hottest component', fmt: pct },
  degradedRate: { label: 'Degraded responses', fmt: pct },
  availability: { label: 'Availability (whole run)', fmt: x => (x * 100).toFixed(2) + '%' },
  avgCost: { label: 'Average cost / month', fmt: usd },
};

const app = {
  graph: { nodes: [], edges: [] },
  sim: null,
  running: false,
  speed: 2,
  selected: null,
  lesson: null,
  tab: 'learn',
  undo: [],
  redo: [],
  insights: [],
  goals: [],
  finished: false,
  hintsShown: 0,
  snapshot: null,
};
window.__bp = app;
app.lessons = LESSONS; // read by the /prep hub's data builder (quiz bank for its question of the day)
app.toast = (...a) => toast(...a);

// ---------------------------------------------------------------- boot
function boot() {
  document.body.innerHTML = layout();
  app.editor = new Editor($('#canvas'), app);
  bindChrome();
  renderPalette();
  route();
  window.addEventListener('hashchange', route);
  requestAnimationFrame(loop);
  if (!store.get('welcomed')) showWelcome();
}

function layout() {
  return `
  <header class="topbar">
    <button class="icon-btn" id="btn-menu" title="Show/hide course outline">☰</button>
    <a class="brand" href="#/" title="Home"><span class="logo">◆</span><span class="brand-name">Backpressure</span><span class="brand-tag">system design, simulated</span></a>
    <div class="crumb" id="crumb"></div>
    <div class="run-ctl">
      <button class="btn primary" id="btn-run">▶ Run</button>
      <button class="icon-btn" id="btn-reset" title="Reset simulation (keeps your design)">⟲</button>
      <select id="speed" title="Simulation speed"><option value="1">1×</option><option value="2" selected>2×</option><option value="5">5×</option><option value="10">10×</option></select>
      <span class="clock" id="clock">0.0s</span>
    </div>
    <div class="top-actions">
      <div class="menu-wrap"><button class="btn ghost" id="btn-chaos" title="Inject failures">💥<span class="lbl"> Chaos</span></button><div class="menu" id="chaos-menu"></div></div>
      <button class="icon-btn" id="btn-undo" title="Undo (Ctrl+Z)">↶</button>
      <button class="icon-btn" id="btn-redo" title="Redo (Ctrl+Y)">↷</button>
      <div class="menu-wrap"><button class="icon-btn" id="btn-more" title="More">⋯</button><div class="menu" id="more-menu">
        <button data-act="share">🔗 Copy share link</button>
        <button data-act="export">⬇ Export design (JSON)</button>
        <button data-act="import">⬆ Import design</button>
        <button data-act="sandbox-copy">🧪 Open copy in Sandbox</button>
        <button data-act="clear">🗑 Clear canvas</button>
        <button data-act="help">❔ How it works</button>
      </div></div>
      <button class="icon-btn only-mobile" id="btn-panel" title="Panel">▤</button>
    </div>
  </header>
  <div class="main">
    <aside class="sidebar" id="sidebar"></aside>
    <section class="stage">
      <div id="canvas"></div>
      <div class="palette" id="palette"></div>
      <div class="kpis" id="kpis"></div>
      <div class="runbar" id="runbar"><i></i></div>
    </section>
    <aside class="panel" id="panel">
      <nav class="tabs" id="tabs">
        <button data-tab="learn">Learn</button>
        <button data-tab="lab">Lab</button>
        <button data-tab="inspect">Inspect</button>
        <button data-tab="metrics">Metrics</button>
        <button data-tab="trace">Trace</button>
      </nav>
      <div class="panel-body" id="panel-body"></div>
    </aside>
  </div>
  <div class="ctx-menu" id="ctx"></div>
  <div class="toasts" id="toasts"></div>
  <div class="modal-wrap" id="modal"></div>
  <input type="file" id="file-in" accept="application/json,.json" hidden>`;
}

// ---------------------------------------------------------------- routing
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('d=')) {
    decodeDesign(h.slice(2)).then(obj => {
      loadSandbox(obj.graph || obj, 'Shared design');
      toast('Loaded a shared design into the Sandbox.');
    }).catch(() => { toast('That share link is broken.', 'bad'); loadSandbox(); });
    return;
  }
  if (!h || h === 'sandbox') {
    if (!h && !store.get('lastLesson') && LESSONS[0]) return loadLesson(LESSONS[0].id, true);
    if (!h && store.get('lastLesson')) return loadLesson(store.get('lastLesson'), true);
    return loadSandbox();
  }
  const L = findLesson(h);
  if (L) loadLesson(L.id, true);
  else loadSandbox();
}

function loadLesson(id, fromRoute) {
  const L = findLesson(id);
  if (!L) return;
  stop();
  app.lesson = L;
  const saved = store.design(L.id);
  app.graph = clone(saved || L.lab?.graph || { nodes: [], edges: [] });
  app.undo = []; app.redo = []; app.selected = null; app.hintsShown = 0;
  app.snapshot = JSON.stringify(app.graph);
  app.solutionSnapshot = L.lab?.solution ? fingerprint(L.lab.solution) : null;
  store.set('lastLesson', L.id);
  if (!fromRoute || location.hash !== '#/' + L.id) history.replaceState(null, '', '#/' + L.id);
  resetSim();
  app.editor.render();
  requestAnimationFrame(() => app.editor.fit());
  setTab('learn');
  renderSidebar();
  renderCrumb();
  $('#panel-body').scrollTop = 0;
  document.body.classList.remove('show-sidebar');
}

function loadSandbox(graph, title) {
  stop();
  app.lesson = null;
  app.graph = clone(graph || store.design('sandbox') || TEMPLATES[0].graph);
  app.undo = []; app.redo = []; app.selected = null;
  app.snapshot = JSON.stringify(app.graph);
  app.sandboxTitle = title || 'Sandbox';
  if (location.hash !== '#/sandbox') history.replaceState(null, '', '#/sandbox');
  resetSim();
  app.editor.render();
  requestAnimationFrame(() => app.editor.fit());
  setTab('learn');
  renderSidebar();
  renderCrumb();
  document.body.classList.remove('show-sidebar');
}

function designKey() { return app.lesson ? app.lesson.id : 'sandbox'; }

// ---------------------------------------------------------------- sim control
function resetSim() {
  app.sim = new Simulation(app.graph, app.lesson?.lab || {});
  app.sim.index();
  app.running = false;
  app.finished = false;
  app.insights = [];
  app.seen = new Set();
  app.goals = (app.lesson?.lab?.goals || []).map(g => ({ ...g, failed: false, cur: null }));
  app.acc = 0;
  updateRunButton();
  renderPanel();
}

function start() {
  if (app.finished) resetSim();
  app.running = true;
  updateRunButton();
}
function stop() { app.running = false; updateRunButton(); }

function updateRunButton() {
  const b = $('#btn-run');
  if (!b) return;
  b.textContent = app.running ? '⏸ Pause' : app.sim && app.sim.t > 0 && !app.finished ? '▶ Resume' : '▶ Run';
  b.classList.toggle('running', app.running);
}

let lastFrame = performance.now();
let lastPanel = 0;
function loop(now) {
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const sim = app.sim;
  if (app.running && sim) {
    app.acc += dtReal * app.speed;
    let steps = 0;
    while (app.acc >= DT && steps < 60) {
      sim.step();
      app.acc -= DT;
      steps++;
      if (sim.tick % 5 === 0) { evalGoals(); if (app.finished) break; }
    }
    if (sim.tick % 3 === 0 || steps > 2) refreshInsights();
  }
  if (sim) {
    app.editor.updateLive(sim, dtReal * Math.min(app.speed, 3) * 0.9, app.running, app.insights);
    if (now - lastPanel > 250) { lastPanel = now; renderLive(); }
  }
  requestAnimationFrame(loop);
}

function refreshInsights() {
  const sim = app.sim;
  app.insights = diagnose(sim);
  for (const it of app.insights) {
    if (it.sev !== 'bad') continue;
    const k = (it.node || '') + it.title;
    if (app.seen.has(k)) continue;
    app.seen.add(k);
    const n = sim.graph.nodes.find(x => x.id === it.node);
    sim.say('bad', `${n ? nm(n) + ': ' : ''}${it.title}. ${it.text}`, n);
  }
}

// ---------------------------------------------------------------- goals
function cmp(v, op, t) {
  if (v == null || !isFinite(v)) v = 0;
  switch (op) { case '<': return v < t; case '<=': return v <= t; case '>': return v > t; case '>=': return v >= t; default: return true; }
}

function evalGoals() {
  const L = app.lesson;
  const sim = app.sim;
  if (!L?.lab) return;
  const m = sim.rolling(3);
  for (const g of app.goals) {
    g.cur = m[g.metric];
    if (g.at === 'end') continue;
    if (sim.t < (g.after ?? 8)) continue;
    if (!g.failed && !cmp(g.cur, g.op, g.value)) { g.failed = true; g.failedAt = sim.t; g.failValue = g.cur; }
  }
  if (sim.t >= (L.lab.duration || 60) - 1e-9) finishRun();
}

function finishRun() {
  app.running = false;
  app.finished = true;
  const m = app.sim.rolling(3);
  for (const g of app.goals) if (g.at === 'end') { g.cur = m[g.metric]; g.failed = !cmp(g.cur, g.op, g.value); }
  const passed = app.goals.length > 0 && app.goals.every(g => !g.failed);
  updateRunButton();
  renderPanel();
  if (passed) {
    const usedSolution = app.solutionSnapshot && app.solutionSnapshot === fingerprint(app.graph);
    const first = !store.completed()[app.lesson.id];
    if (!usedSolution) store.markComplete(app.lesson.id, { cost: Math.round(m.cost) });
    renderSidebar();
    showResult(true, first, usedSolution);
  } else showResult(false);
}

function showResult(passed, first, usedSolution) {
  const L = app.lesson;
  const failed = app.goals.filter(g => g.failed);
  const next = LESSONS[LESSONS.indexOf(L) + 1];
  const body = passed
    ? `<div class="result pass"><div class="big">${usedSolution ? '📘 Reference solution works' : '✅ Lab passed'}</div>
        <p>${usedSolution ? 'That was the unmodified reference design, so it doesn’t count toward your progress. Reset to the starter and build it yourself (or improve on it) to earn the check mark.' : first ? 'Nice. That design survived everything the scenario threw at it.' : 'Passed again.'} Final cost: <b>${usd(app.sim.rolling(3).cost)}/mo</b>.</p>
        ${L.lab.debrief ? `<div class="debrief">${md(L.lab.debrief)}</div>` : ''}
        <div class="modal-actions">${next ? `<button class="btn primary" data-go="${next.id}">Next: ${esc(next.title)} →</button>` : ''}<button class="btn ghost" data-close>Keep experimenting</button></div></div>`
    : `<div class="result fail"><div class="big">❌ Not yet</div>
        <p>Goals that failed:</p><ul>${failed.map(g => `<li><b>${esc(g.label || METRICS[g.metric]?.label)}</b> broke at ${secs(g.failedAt ?? app.sim.t)}: was ${(METRICS[g.metric]?.fmt || String)(g.failValue ?? g.cur)} (target ${g.op} ${(METRICS[g.metric]?.fmt || String)(g.value)})</li>`).join('')}</ul>
        <p class="muted">Check the <b>Metrics</b> tab and the callouts on the canvas to see what broke first. Hints are in the Lab tab.</p>
        <div class="modal-actions"><button class="btn primary" data-retry>Tweak & retry</button><button class="btn ghost" data-hint>Show a hint</button></div></div>`;
  modal(body, el => {
    el.querySelector('[data-go]')?.addEventListener('click', e => { closeModal(); location.hash = '#/' + e.target.dataset.go; });
    el.querySelector('[data-retry]')?.addEventListener('click', () => { closeModal(); resetSim(); setTab('lab'); });
    el.querySelector('[data-hint]')?.addEventListener('click', () => { closeModal(); resetSim(); app.hintsShown = Math.max(app.hintsShown, 1); setTab('lab'); });
  });
}

// ---------------------------------------------------------------- graph edits
app.commit = (reason, quiet) => {
  const snap = JSON.stringify(app.graph);
  if (snap === app.snapshot) return;
  app.undo.push(app.snapshot);
  if (app.undo.length > 80) app.undo.shift();
  app.redo = [];
  app.snapshot = snap;
  store.saveDesign(designKey(), app.graph);
  app.editor.render();
  if (!quiet) renderPanel();
};

function undo() {
  if (!app.undo.length) return;
  app.redo.push(app.snapshot);
  app.snapshot = app.undo.pop();
  replaceGraph(JSON.parse(app.snapshot));
}
function redo() {
  if (!app.redo.length) return;
  app.undo.push(app.snapshot);
  app.snapshot = app.redo.pop();
  replaceGraph(JSON.parse(app.snapshot));
}
function replaceGraph(g) {
  app.graph.nodes = g.nodes;
  app.graph.edges = g.edges;
  store.saveDesign(designKey(), app.graph);
  if (app.selected && !findSel()) app.selected = null;
  app.editor.render();
  renderPanel();
}

app.connect = (from, to) => {
  const a = app.graph.nodes.find(n => n.id === from), b = app.graph.nodes.find(n => n.id === to);
  if (!a || !b) return;
  if (b.type === 'client') return toast('Users only send traffic. They can’t be a target.', 'warn');
  if (app.graph.edges.some(e => e.from === from && e.to === to)) return toast('Already connected.');
  if (app.graph.edges.some(e => e.from === to && e.to === from)) return toast('That would create a loop. Traffic flows one way.', 'warn');
  const tip = connectionTip(a, b);
  app.graph.edges.push({ id: newId('e'), from, to });
  app.commit('connect');
  if (tip) toast(tip, 'info');
};

function connectionTip(a, b) {
  if (a.type === 'client' && ['sqldb', 'nosql', 'shard', 'replica', 'cache'].includes(b.type)) return 'Users straight to a datastore? Real clients go through servers. Put an App Server in between.';
  if (b.type === 'replica' && a.type !== 'sqldb' && !app.graph.edges.some(e => e.to === b.id && app.graph.nodes.find(n => n.id === e.from)?.type === 'sqldb')) return 'Remember to connect SQL Primary → Read Replica so it receives replication.';
  if (b.type === 'worker' && a.type !== 'queue') return 'Workers usually consume from a Queue.';
  return '';
}

function addNode(type, x, y) {
  const n = makeNode(type, x, y);
  app.graph.nodes.push(n);
  app.commit('add');
  app.select({ kind: 'node', id: n.id });
  return n;
}

function deleteSel() {
  const s = app.selected;
  if (!s) return;
  if (s.kind === 'node') {
    app.graph.nodes = app.graph.nodes.filter(n => n.id !== s.id);
    app.graph.edges = app.graph.edges.filter(e => e.from !== s.id && e.to !== s.id);
  } else app.graph.edges = app.graph.edges.filter(e => e.id !== s.id);
  app.selected = null;
  app.commit('delete');
}

function duplicateSel() {
  const n = findSel();
  if (!n || app.selected.kind !== 'node') return;
  const c = makeNode(n.type, n.x + 32, n.y + 120, clone(n.params), n.label ? n.label + ' 2' : '');
  app.graph.nodes.push(c);
  for (const e of app.graph.edges.filter(e => e.to === n.id)) app.graph.edges.push({ id: newId('e'), from: e.from, to: c.id });
  for (const e of app.graph.edges.filter(e => e.from === n.id)) app.graph.edges.push({ id: newId('e'), from: c.id, to: e.to });
  app.commit('dup');
  app.select({ kind: 'node', id: c.id });
}

function findSel() {
  const s = app.selected;
  if (!s) return null;
  return s.kind === 'node' ? app.graph.nodes.find(n => n.id === s.id) : app.graph.edges.find(e => e.id === s.id);
}

app.select = (sel, focus) => {
  app.selected = sel;
  app.editor.render();
  if (sel) setTab('inspect'); else if (app.tab === 'inspect') renderPanel();
  if (focus) setTimeout(() => $('#panel-body input[data-label]')?.focus(), 0);
};

// ---------------------------------------------------------------- chaos
function chaosAction(act, id) {
  const sim = app.sim;
  const n = id ? app.graph.nodes.find(x => x.id === id) : null;
  if (!app.running && sim.t === 0) start();
  switch (act) {
    case 'kill': sim.kill(n); break;
    case 'restore': sim.restore(n); break;
    case 'slow': sim.doAction({ do: 'slow', target: n.id }); break;
    case 'unslow': sim.doAction({ do: 'unslow', target: n.id }); break;
    case 'failNode': sim.doAction({ do: 'failNode', target: n.id }); break;
    case 'partitionNode': sim.doAction({ do: 'partition', target: n.id }); break;
    case 'spike': sim.doAction({ do: 'spike', factor: 5, duration: 20 }); break;
    case 'spike10': sim.doAction({ do: 'spike', factor: 10, duration: 15 }); break;
    case 'killRandom': {
      const c = app.graph.nodes.filter(x => ['app', 'worker', 'cache', 'replica', 'sqldb'].includes(x.type) && !sim.ns.get(x.id)?.down);
      if (c.length) sim.kill(c[Math.floor(Math.random() * c.length)]);
      break;
    }
    case 'region': sim.doAction({ do: 'region', region: id }); break;
    case 'heal': sim.doAction({ do: 'heal' }); break;
    case 'restoreAll': for (const x of app.graph.nodes) { sim.restore(x); const s = sim.ns.get(x.id); if (s) { s.slow = false; s.failedNodes = 0; s.partitioned = false; } } for (const e of app.graph.edges) { const E = sim.es.get(e.id); if (E) E.cut = false; } sim.say('info', 'Everything restored.'); break;
    case 'cutEdge': { const E = sim.E(app.graph.edges.find(e => e.id === id)); E.cut = true; E.cutSince = sim.t; sim.say('chaos', 'Network partition on a link.'); break; }
    case 'healEdge': { const E = sim.E(app.graph.edges.find(e => e.id === id)); E.cut = false; sim.say('info', 'Link healed.'); break; }
  }
  refreshInsights();
  renderPanel();
}

app.openContextMenu = (sel, x, y) => {
  const ctx = $('#ctx');
  const sim = app.sim;
  let items = [];
  if (sel.kind === 'node') {
    const n = app.graph.nodes.find(z => z.id === sel.id);
    const st = sim.ns.get(n.id);
    if (n.type !== 'client') {
      items.push(st?.down ? ['restore', '✅ Restore'] : ['kill', '💀 Kill']);
      items.push(st?.slow ? ['unslow', '🐇 Remove slowness'] : ['slow', '🐢 Make 10× slower']);
      if (n.type === 'nosql') { items.push(['failNode', '🧱 Fail one node']); items.push(['partitionNode', '✂ Network partition']); }
    }
    items.push(['dup', '⧉ Duplicate'], ['del', '🗑 Delete']);
  } else {
    const E = sim.es.get(sel.id);
    items.push(E?.cut ? ['healEdge', '🩹 Heal link'] : ['cutEdge', '✂ Partition link']);
    items.push(['del', '🗑 Delete connection']);
  }
  ctx.innerHTML = items.map(([a, l]) => `<button data-a="${a}">${l}</button>`).join('');
  ctx.style.left = Math.min(x, innerWidth - 200) + 'px';
  ctx.style.top = Math.min(y, innerHeight - 40 * items.length) + 'px';
  ctx.classList.add('open');
  ctx.onclick = e => {
    const a = e.target.closest('button')?.dataset.a;
    ctx.classList.remove('open');
    if (!a) return;
    if (a === 'del') return deleteSel();
    if (a === 'dup') return duplicateSel();
    chaosAction(a, sel.id);
  };
};

// ---------------------------------------------------------------- chrome
function bindChrome() {
  $('#btn-run').onclick = () => (app.running ? stop() : start());
  $('#btn-reset').onclick = () => { resetSim(); toast('Simulation reset. Your design is unchanged.'); };
  $('#speed').onchange = e => { app.speed = +e.target.value; };
  $('#btn-undo').onclick = undo;
  $('#btn-redo').onclick = redo;
  $('#btn-menu').onclick = () => {
    if (innerWidth <= 980) document.body.classList.toggle('show-sidebar');
    else { document.body.classList.toggle('hide-sidebar'); store.set('hideSidebar', document.body.classList.contains('hide-sidebar')); setTimeout(() => app.editor.fit(), 50); }
  };
  if (store.get('hideSidebar', innerWidth < 1350)) document.body.classList.add('hide-sidebar');
  $('#btn-panel').onclick = () => document.body.classList.toggle('show-panel');
  $('#tabs').onclick = e => { const t = e.target.dataset.tab; if (t) setTab(t); };

  const chaos = $('#chaos-menu');
  chaos.innerHTML = `
    <div class="menu-h">Traffic</div>
    <button data-c="spike">📈 Spike ×5 for 20s</button>
    <button data-c="spike10">🚀 Spike ×10 for 15s</button>
    <div class="menu-h">Failures</div>
    <button data-c="killRandom">🎲 Kill a random server/DB</button>
    ${REGIONS.map(r => `<button data-c="region" data-r="${r}">🌩 Region outage: ${r}</button>`).join('')}
    <div class="menu-h">Recovery</div>
    <button data-c="heal">🩹 Heal all partitions</button>
    <button data-c="restoreAll">✅ Restore everything</button>
    <div class="menu-foot">Tip: right-click any component or connection for targeted chaos.</div>`;
  $('#btn-chaos').onclick = e => { e.stopPropagation(); toggleMenu(chaos); };
  chaos.onclick = e => { const b = e.target.closest('button'); if (!b) return; chaos.classList.remove('open'); chaosAction(b.dataset.c, b.dataset.r); };

  const more = $('#more-menu');
  $('#btn-more').onclick = e => { e.stopPropagation(); toggleMenu(more); };
  more.onclick = async e => {
    const a = e.target.closest('button')?.dataset.act;
    more.classList.remove('open');
    if (a === 'share') {
      const code = await encodeDesign({ graph: app.graph });
      const url = location.origin + location.pathname + '#d=' + code;
      try { await navigator.clipboard.writeText(url); toast('Share link copied to clipboard.'); } catch { prompt('Copy this link:', url); }
    }
    if (a === 'export') {
      const blob = new Blob([JSON.stringify({ app: 'backpressure', version: 1, graph: app.graph }, null, 2)], { type: 'application/json' });
      const aEl = document.createElement('a');
      aEl.href = URL.createObjectURL(blob);
      aEl.download = (app.lesson ? app.lesson.id : 'sandbox') + '.json';
      aEl.click();
    }
    if (a === 'import') $('#file-in').click();
    if (a === 'sandbox-copy') { const g = clone(app.graph); store.saveDesign('sandbox', g); loadSandbox(g); }
    if (a === 'clear') { if (confirm('Remove everything from the canvas?')) { app.graph.nodes = []; app.graph.edges = []; app.selected = null; app.commit('clear'); resetSim(); } }
    if (a === 'help') showWelcome();
  };
  $('#file-in').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      const g = obj.graph || obj;
      if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('bad');
      g.nodes = g.nodes.filter(n => CATALOG[n.type]);
      loadSandbox(g, f.name);
      store.saveDesign('sandbox', app.graph);
      toast('Design imported into the Sandbox.');
    } catch { toast('That file is not a Backpressure design.', 'bad'); }
    e.target.value = '';
  };

  document.addEventListener('click', e => {
    if (!e.target.closest('.menu-wrap')) document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
    if (!e.target.closest('#ctx')) $('#ctx').classList.remove('open');
  });
  document.addEventListener('keydown', e => {
    const typing = /input|textarea|select/i.test(document.activeElement?.tagName || '');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (typing) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (app.selected) { e.preventDefault(); deleteSel(); } }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSel(); }
    if (e.key === ' ') { e.preventDefault(); app.running ? stop() : start(); }
    if (e.key === 'Escape') { app.editor.cancelPending(); app.select(null); closeModal(); }
  });
}

function toggleMenu(m) {
  const open = m.classList.contains('open');
  document.querySelectorAll('.menu.open').forEach(x => x.classList.remove('open'));
  if (!open) m.classList.add('open');
}

function renderCrumb() {
  const L = app.lesson;
  $('#crumb').innerHTML = L
    ? `<span class="muted">Weeks ${esc(L.week)} · ${esc(L.module)}</span><b>${esc(L.title)}</b>`
    : `<span class="muted">Free build</span><b>${esc(app.sandboxTitle || 'Sandbox')}</b>`;
  document.title = (L ? L.title : 'Sandbox') + ' · Backpressure';
}

// ---------------------------------------------------------------- sidebar
function renderSidebar() {
  const done = store.completed();
  const count = LESSONS.filter(l => done[l.id]).length;
  const cur = app.lesson?.id;
  let h = `<div class="side-head">
    <div class="progress-label"><span>Your progress</span><b>${count}/${LESSONS.length} labs</b></div>
    <div class="progress"><i style="width:${(count / LESSONS.length) * 100}%"></i></div>
    <a class="side-item sandbox ${!app.lesson ? 'active' : ''}" href="#/sandbox"><span class="dot">🧪</span><span>Sandbox: free build</span></a>
  </div>`;
  for (const mod of COURSE) {
    const md = mod.lessons.filter(l => done[l.id]).length;
    h += `<div class="mod"><div class="mod-h"><span class="wk">Weeks ${esc(mod.week)}</span><span class="mod-t">${esc(mod.title)}</span><span class="mod-c">${md}/${mod.lessons.length}</span></div>`;
    for (const l of mod.lessons) {
      h += `<a class="side-item ${l.id === cur ? 'active' : ''} ${done[l.id] ? 'done' : ''}" href="#/${l.id}"><span class="dot">${done[l.id] ? '✓' : ''}</span><span>${esc(l.title)}</span></a>`;
    }
    h += '</div>';
  }
  h += `<div class="side-foot">Built for learning. Numbers are realistic approximations, not benchmarks.</div>`;
  $('#sidebar').innerHTML = h;
  $('#sidebar .active')?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- palette
function renderPalette() {
  const pal = $('#palette');
  let h = '<button class="pal-toggle" title="Components">＋</button><div class="pal-list">';
  for (const cat of CATEGORIES) {
    h += `<div class="pal-cat">${cat}</div>`;
    for (const [type, def] of Object.entries(CATALOG)) {
      if (def.category !== cat) continue;
      h += `<div class="pal-item" data-type="${type}" title="${esc(def.desc)}" style="--accent:${def.color}"><span class="ico">${def.icon}</span><span>${esc(def.label)}</span></div>`;
    }
  }
  h += '</div>';
  pal.innerHTML = h;
  pal.querySelector('.pal-toggle').onclick = () => pal.classList.toggle('collapsed');
  if (innerWidth < 900) pal.classList.add('collapsed');
  pal.addEventListener('pointerdown', e => {
    const item = e.target.closest('.pal-item');
    if (!item) return;
    e.preventDefault();
    const type = item.dataset.type;
    const sx = e.clientX, sy = e.clientY;
    let ghost = null;
    const mv = ev => {
      if (!ghost && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 5) {
        ghost = item.cloneNode(true);
        ghost.classList.add('ghost');
        document.body.appendChild(ghost);
      }
      if (ghost) { ghost.style.left = ev.clientX - 20 + 'px'; ghost.style.top = ev.clientY - 16 + 'px'; }
    };
    const up = ev => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      const vp = $('.viewport').getBoundingClientRect();
      if (ghost) {
        ghost.remove();
        if (ev.clientX > vp.left && ev.clientX < vp.right && ev.clientY > vp.top && ev.clientY < vp.bottom && !document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.palette')) {
          const w = app.editor.toWorld(ev.clientX, ev.clientY);
          addNode(type, Math.round((w.x - 90) / 8) * 8, Math.round((w.y - 40) / 8) * 8);
        }
      } else {
        const w = app.editor.toWorld(vp.left + vp.width / 2, vp.top + vp.height / 2);
        const jitter = (app.graph.nodes.length % 5) * 24;
        addNode(type, Math.round((w.x - 90 + jitter) / 8) * 8, Math.round((w.y - 40 + jitter) / 8) * 8);
      }
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  });
}

// ---------------------------------------------------------------- right panel
function setTab(t) {
  app.tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $('#tabs [data-tab="lab"]').style.display = app.lesson?.lab ? '' : 'none';
  renderPanel();
}

function renderPanel() {
  const body = $('#panel-body');
  if (!body) return;
  const t = app.tab;
  if (t === 'learn') body.innerHTML = app.lesson ? learnHTML() : sandboxHTML();
  if (t === 'lab') body.innerHTML = labHTML();
  if (t === 'inspect') body.innerHTML = inspectHTML();
  if (t === 'metrics') body.innerHTML = metricsHTML();
  if (t === 'trace') body.innerHTML = traceHTML();
  bindPanel(body);
  renderLive(true);
}

function learnHTML() {
  const L = app.lesson;
  const done = store.completed()[L.id];
  const idx = LESSONS.indexOf(L);
  const prev = LESSONS[idx - 1], next = LESSONS[idx + 1];
  return `<article class="lesson">
    <div class="lesson-meta"><span class="pill">Weeks ${esc(L.week)}</span><span class="pill">${esc(L.module)}</span><span class="pill">~${L.minutes || 15} min</span>${done ? '<span class="pill ok">✓ lab passed</span>' : ''}</div>
    <h1>${esc(L.title)}</h1>
    ${L.summary ? `<p class="lede">${esc(L.summary)}</p>` : ''}
    <div class="md">${md(L.body || '')}</div>
    ${L.calculator ? '<div id="calc"></div>' : ''}
    ${L.quiz?.length ? quizHTML(L) : ''}
    ${L.lab ? `<div class="cta"><button class="btn primary" data-act="go-lab">Go to the lab →</button><span class="muted">${esc(firstLine(L.lab.brief))}</span></div>` : ''}
    <div class="pager">${prev ? `<a href="#/${prev.id}">← ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a href="#/${next.id}">${esc(next.title)} →</a>` : ''}</div>
  </article>`;
}

function firstLine(s = '') { return s.replace(/[#*`>]/g, '').split('\n').find(x => x.trim()) || ''; }

function quizHTML(L) {
  return `<section class="quiz"><h2>Check yourself</h2>${L.quiz.map((q, i) => `
    <div class="q" data-q="${i}"><div class="q-t">${i + 1}. ${md(q.q).replace(/^<p>|<\/p>$/g, '')}</div>
    ${q.options.map((o, j) => `<button class="opt" data-q="${i}" data-o="${j}">${esc(o)}</button>`).join('')}
    <div class="why" hidden></div></div>`).join('')}</section>`;
}

function sandboxHTML() {
  return `<article class="lesson">
    <div class="lesson-meta"><span class="pill">Sandbox</span></div>
    <h1>Build anything</h1>
    <p class="lede">No goals, no timer. Drag components in, wire them up, crank the traffic and break things.</p>
    <div class="md">${md(`
**How to use the canvas**
- **Add**: drag a component from the palette (or click it).
- **Connect**: drag from the ● on a node's right edge onto another node. Traffic flows left → right.
- **Configure**: click a node to open the Inspector. Every knob changes the simulation live.
- **Break**: right-click a node or link, or use 💥 Chaos.
- **Understand**: watch the callouts, then the **Metrics** and **Trace** tabs.

**Reading the animation**: <span>blue</span> dots are reads, amber are writes, violet are static assets, red are failing requests. Dashed links are asynchronous.
`)}</div>
    <h2>Start from a template</h2>
    <div class="templates">${TEMPLATES.map((t, i) => `<button class="tpl" data-tpl="${i}"><b>${esc(t.title)}</b><span>${esc(t.desc)}</span></button>`).join('')}</div>
  </article>`;
}

function labHTML() {
  const L = app.lesson;
  if (!L?.lab) return '<p class="muted pad">This lesson has no lab.</p>';
  const lab = L.lab;
  const ev = (lab.events || []).filter(e => e.do !== 'say');
  return `<div class="lab">
    <h2>Lab: ${esc(lab.title || L.title)}</h2>
    <div class="md">${md(lab.brief || '')}</div>
    <div class="lab-run"><b>Run length:</b> ${lab.duration || 60}s of simulated time${ev.length ? `<div class="timeline">${ev.map(e => `<div class="ev"><span class="at">${e.at}s</span>${esc(describeEvent(e))}</div>`).join('')}</div>` : ''}</div>
    <h3>Goals</h3>
    <div id="goals"></div>
    <div class="lab-actions">
      <button class="btn primary" data-act="run">${app.running ? '⏸ Pause' : '▶ Run the scenario'}</button>
      <button class="btn ghost" data-act="starter">Reset to starter design</button>
    </div>
    ${lab.hints?.length ? `<h3>Hints</h3><div class="hints">${lab.hints.slice(0, app.hintsShown).map((h, i) => `<div class="hint"><b>Hint ${i + 1}.</b> ${md(h).replace(/^<p>|<\/p>$/g, '')}</div>`).join('')}
      ${app.hintsShown < lab.hints.length ? `<button class="btn ghost small" data-act="hint">Reveal hint ${app.hintsShown + 1} of ${lab.hints.length}</button>` : ''}</div>` : ''}
    ${lab.solution ? `<div class="solution"><button class="btn ghost small" data-act="solution">Load reference solution</button><span class="muted">Replaces your design (you can undo).</span></div>` : ''}
  </div>`;
}

function describeEvent(e) {
  const n = e.target ? (app.graph.nodes.find(x => x.id === e.target) || app.graph.nodes.find(x => x.type === e.target) || (CATALOG[e.target] ? { type: e.target } : { label: e.target })) : null;
  const name = n ? (n.label || CATALOG[n.type]?.label || e.target) : '';
  switch (e.do) {
    case 'spike': return `Traffic spike ×${e.factor ?? 5} for ${e.duration ?? 20}s`;
    case 'kill': return `${name} dies`;
    case 'restore': return `${name} comes back`;
    case 'slow': return `${name} becomes 10× slower`;
    case 'unslow': return `${name} recovers`;
    case 'partition': return e.to ? `Network partition: ${name} ↮ ${e.to}` : `Network partition in ${name}`;
    case 'heal': return 'Network heals';
    case 'failNode': return `One node of ${name} fails`;
    case 'region': return `Region outage: ${e.region}`;
    default: return e.text || e.do;
  }
}

function goalsHTML() {
  if (!app.goals.length) return '<p class="muted">No goals: free exploration.</p>';
  const sim = app.sim;
  return app.goals.map(g => {
    const fmt = METRICS[g.metric]?.fmt || String;
    let state = g.failed ? 'fail' : app.finished ? 'pass' : 'wait';
    if (state === 'wait' && g.cur != null && sim.t > 0) {
      const okNow = cmp(g.cur, g.op, g.value);
      // End-of-run goals are only judged at the end: show "off target right now" as a warning.
      if (g.at === 'end') state = okNow ? 'ok' : 'warn';
      else if (sim.t >= (g.after ?? 8)) state = okNow ? 'ok' : 'fail';
    }
    const icon = { fail: '✗', pass: '✓', ok: '●', wait: '○', warn: '◐' }[state];
    return `<div class="goal ${state}"><span class="gi">${icon}</span><span class="gl">${esc(g.label || METRICS[g.metric].label)}<small>${g.at === 'end' ? 'checked at the end' : 'must hold for the whole run'}</small></span><span class="gv">${g.cur != null ? fmt(g.cur) : '–'}<small>${g.op} ${fmt(g.value)}</small></span></div>`;
  }).join('');
}

function inspectHTML() {
  const s = app.selected;
  if (!s) return `<div class="pad empty-state"><div class="big">🔍</div><p>Select a component or connection to inspect it.</p><p class="muted">Tip: double-click a node to rename it.</p></div>`;
  if (s.kind === 'edge') return edgeInspectHTML(findSel());
  const n = findSel();
  if (!n) return '';
  const def = CATALOG[n.type];
  let form = '';
  for (const p of def.params) {
    if (p.showIf && !p.showIf(n.params)) continue;
    const v = n.params[p.key];
    let input = '';
    if (p.kind === 'toggle') input = `<label class="switch"><input type="checkbox" data-k="${p.key}" ${v ? 'checked' : ''}><span></span></label>`;
    else if (p.kind === 'select') input = `<select data-k="${p.key}">${p.options.map(o => `<option value="${o}" ${String(o) === String(v) ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    else if (p.kind === 'range') input = `<div class="range"><input type="range" data-k="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}"><output>${fmtParam(p, v)}</output></div>`;
    else input = `<input type="number" data-k="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}">`;
    form += `<div class="field ${p.kind}"><label>${esc(p.label)}${p.help ? `<i class="help" title="${esc(p.help)}">?</i>` : ''}</label>${input}</div>`;
  }
  const st = app.sim.ns.get(n.id);
  return `<div class="inspect">
    <div class="ins-head" style="--accent:${def.color}"><span class="ico">${def.icon}</span><div><input data-label value="${esc(n.label || '')}" placeholder="${esc(def.label)}"><small>${esc(def.label)}</small></div></div>
    <p class="muted">${esc(def.desc)}</p>
    <div class="ins-actions">
      ${n.type !== 'client' ? `<button class="btn small ghost" data-chaos="${st?.down ? 'restore' : 'kill'}">${st?.down ? '✅ Restore' : '💀 Kill'}</button><button class="btn small ghost" data-chaos="${st?.slow ? 'unslow' : 'slow'}">${st?.slow ? '🐇 Normal speed' : '🐢 Slow 10×'}</button>` : ''}
      <button class="btn small ghost" data-act="dup">⧉ Duplicate</button><button class="btn small ghost danger" data-act="del">🗑 Delete</button>
    </div>
    <h3>Live</h3><div id="live-node"></div>
    <h3>Configuration</h3><div class="form">${form}</div>
  </div>`;
}

function fmtParam(p, v) { return p.max <= 1 ? Math.round(v * 100) + '%' : v; }

function edgeInspectHTML(e) {
  if (!e) return '';
  const a = app.graph.nodes.find(n => n.id === e.from), b = app.graph.nodes.find(n => n.id === e.to);
  return `<div class="inspect">
    <div class="ins-head"><span class="ico">↔</span><div><b>${esc(nm(a))} → ${esc(nm(b))}</b><small>Connection</small></div></div>
    <div class="ins-actions"><button class="btn small ghost" data-chaos="${app.sim.es.get(e.id)?.cut ? 'healEdge' : 'cutEdge'}">${app.sim.es.get(e.id)?.cut ? '🩹 Heal link' : '✂ Partition link'}</button><button class="btn small ghost danger" data-act="del">🗑 Delete</button></div>
    <h3>Live</h3><div id="live-edge"></div>
    <p class="muted">${edgeExplain(a, b)}</p>
  </div>`;
}

function edgeExplain(a, b) {
  if (a.type === 'sqldb' && b.type === 'replica') return 'Replication stream: every write on the primary is shipped and re-applied here.';
  if (a.type === 'queue') return 'Asynchronous: consumers pull at their own pace. Their latency does not reach the user.';
  if (['app', 'worker'].includes(a.type)) return 'A synchronous call: the caller waits for the reply. Its timeout, retries and circuit breaker settings apply here.';
  return 'Requests flow from left to right along this link.';
}

function metricsHTML() {
  return `<div class="metrics">
    <div class="tiles" id="tiles"></div>
    <h3>Throughput <small><i class="sw" style="background:#64748b"></i>offered <i class="sw" style="background:#34d399"></i>successful</small></h3><div class="chart-box" id="ch-thr"></div>
    <h3>Latency <small><i class="sw" style="background:#38bdf8"></i>p50 <i class="sw" style="background:#f472b6"></i>p99</small></h3><div class="chart-box" id="ch-lat"></div>
    <h3>Failures <small><i class="sw" style="background:#ef4444"></i>errors <i class="sw" style="background:#fbbf24"></i>429s <i class="sw" style="background:#a78bfa"></i>stale reads</small></h3><div class="chart-box" id="ch-err"></div>
    <h3>Cost / month</h3><div class="chart-box" id="ch-cost"></div>
    <h3>What's happening</h3><div id="insights"></div>
    <h3>Event log</h3><div class="log" id="log"></div>
  </div>`;
}

function traceHTML() {
  return `<div class="trace"><p class="muted">A sampled request traced through your system, like a distributed tracing tool (Jaeger, Honeycomb). Bars show where time goes at the median.</p>
  <div class="trace-tabs"><button data-cls="r" class="${(app.traceCls || 'r') === 'r' ? 'active' : ''}">Read request</button><button data-cls="w" class="${app.traceCls === 'w' ? 'active' : ''}">Write request</button><button data-cls="s" class="${app.traceCls === 's' ? 'active' : ''}">Static asset</button></div>
  <div id="trace-body"></div></div>`;
}

function bindPanel(body) {
  body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'go-lab') { setTab('lab'); app.editor.fit(); }
    if (a === 'run') { app.running ? stop() : start(); renderPanel(); }
    if (a === 'starter') { if (confirm('Replace your design with the starter design?')) { app.graph.nodes = clone(app.lesson.lab.graph.nodes); app.graph.edges = clone(app.lesson.lab.graph.edges); app.commit('starter'); resetSim(); app.editor.fit(); } }
    if (a === 'hint') { app.hintsShown++; renderPanel(); }
    if (a === 'solution') { const s = clone(app.lesson.lab.solution); app.graph.nodes = s.nodes; app.graph.edges = s.edges; app.commit('solution'); resetSim(); app.editor.fit(); toast('Reference solution loaded. Press Run to see it work.'); }
    if (a === 'del') deleteSel();
    if (a === 'dup') duplicateSel();
  }));
  body.querySelectorAll('[data-chaos]').forEach(b => b.addEventListener('click', () => chaosAction(b.dataset.chaos, app.selected?.id)));
  body.querySelectorAll('.opt').forEach(b => b.addEventListener('click', () => {
    const q = app.lesson.quiz[+b.dataset.q];
    const box = b.closest('.q');
    box.querySelectorAll('.opt').forEach((o, j) => { o.classList.toggle('right', j === q.answer); o.classList.toggle('wrong', o === b && j !== q.answer); o.disabled = true; });
    const why = box.querySelector('.why');
    why.hidden = false;
    why.innerHTML = (+b.dataset.o === q.answer ? '<b>Correct.</b> ' : '<b>Not quite.</b> ') + md(q.why).replace(/^<p>|<\/p>$/g, '');
  }));
  body.querySelectorAll('.tpl').forEach(b => b.addEventListener('click', () => {
    const t = TEMPLATES[+b.dataset.tpl];
    if (app.graph.nodes.length && !confirm('Replace the current sandbox design?')) return;
    const g = clone(t.graph);
    app.graph.nodes = g.nodes; app.graph.edges = g.edges;
    app.commit('template'); resetSim(); app.editor.fit();
  }));
  body.querySelectorAll('.trace-tabs button').forEach(b => b.addEventListener('click', () => { app.traceCls = b.dataset.cls; renderPanel(); }));
  if ($('#calc', body) && app.lesson?.calculator) renderCalculator($('#calc', body), app.lesson.calculator);

  // Inspector form
  const n = app.selected?.kind === 'node' ? findSel() : null;
  if (n) {
    const label = body.querySelector('input[data-label]');
    label?.addEventListener('input', () => { n.label = label.value; app.editor.render(); });
    label?.addEventListener('change', () => app.commit('label', true));
    body.querySelectorAll('[data-k]').forEach(inp => {
      const def = CATALOG[n.type].params.find(p => p.key === inp.dataset.k);
      const read = () => {
        if (def.kind === 'toggle') return inp.checked;
        if (def.kind === 'select') return isNaN(+inp.value) || def.options.every(o => typeof o === 'string') ? inp.value : +inp.value;
        const v = +inp.value;
        return isNaN(v) ? def.default : Math.max(def.min ?? -Infinity, Math.min(def.max ?? Infinity, v));
      };
      inp.addEventListener('input', () => {
        n.params[def.key] = read();
        const out = inp.parentElement.querySelector('output');
        if (out) out.textContent = fmtParam(def, n.params[def.key]);
        app.editor.render();
      });
      inp.addEventListener('change', () => {
        n.params[def.key] = read();
        app.commit('param', true);
        if (def.kind === 'toggle' || def.kind === 'select' || def.key === 'retries' || def.key === 'staticRatio' || def.key === 'rateLimit') renderPanel();
      });
    });
  }
}

// Live-updating parts of the panel (called ~4×/s).
function renderLive(force) {
  const sim = app.sim;
  if (!sim) return;
  $('#clock').textContent = sim.t.toFixed(1) + 's' + (app.lesson?.lab ? ` / ${app.lesson.lab.duration || 60}s` : '');
  const bar = $('#runbar i');
  if (bar) bar.style.width = app.lesson?.lab ? Math.min(100, (sim.t / (app.lesson.lab.duration || 60)) * 100) + '%' : '0%';
  renderKpis();
  if (!force && !app.running && sim.t > 0 && app._lastLiveT === sim.t) return;
  app._lastLiveT = sim.t;
  const t = app.tab;
  if (t === 'lab') { const el = $('#goals'); if (el) el.innerHTML = goalsHTML(); const rb = $('[data-act="run"]'); if (rb) rb.textContent = app.running ? '⏸ Pause' : '▶ Run the scenario'; }
  if (t === 'inspect') liveInspect();
  if (t === 'metrics') liveMetrics();
  if (t === 'trace') liveTrace();
}

function renderKpis() {
  const m = app.sim.metrics;
  const r = app.sim.history.length ? app.sim.rolling(2) : m;
  const k = (label, val, cls = '') => `<div class="kpi ${cls}"><span>${label}</span><b>${val}</b></div>`;
  const okCls = r.okRate >= 0.999 ? 'good' : r.okRate >= 0.99 ? 'warn' : 'bad';
  const p99Cls = r.p99 < 300 ? 'good' : r.p99 < 1000 ? 'warn' : 'bad';
  $('#kpis').innerHTML =
    k('Traffic', fmtRps(r.offered) + ' rps') +
    k('Success', pct(r.okRate), r.offered ? okCls : '') +
    k('p50', fmtMs(r.p50)) +
    k('p99', fmtMs(r.p99), r.offered ? p99Cls : '') +
    (r.rejRate > 0.001 ? k('429s', pct(r.rejRate), 'warn') : '') +
    (r.staleRate > 0.001 ? k('Stale', pct(r.staleRate), r.staleRate > 0.01 ? 'warn' : '') : '') +
    (r.consumerLag > 0.5 ? k('Lag', secs(r.consumerLag), r.consumerLag > 10 ? 'bad' : 'warn') : '') +
    (m.lostWrites > 0 ? k('Lost', Math.round(m.lostWrites).toLocaleString(), 'bad') : '') +
    (m.duplicates > 0.5 ? k('Dupes', Math.round(m.duplicates).toLocaleString(), 'bad') : '') +
    k('Cost', usd(r.cost) + '/mo');
}

function liveInspect() {
  const sim = app.sim;
  const s = app.selected;
  if (!s) return;
  if (s.kind === 'edge') {
    const E = sim.es.get(s.id);
    const el = $('#live-edge');
    if (!el) return;
    if (!E) { el.innerHTML = '<p class="muted">Run the simulation to see traffic.</p>'; return; }
    const f = E.flow;
    el.innerHTML = table([
      ['Reads', fmtRps(f.r) + ' rps'], ['Writes', fmtRps(f.w) + ' rps'], ['Static', fmtRps(f.s) + ' rps'],
      ['Retry amplification', '×' + (E.amp || 1).toFixed(2)],
      ['Attempt failure', pct(E.pAttempt || 0)],
      ['Timeouts', pct(E.pLat || 0)],
      ['Circuit breaker', E.cb?.state || 'closed'],
      ['State', E.cut ? 'PARTITIONED' : E.async || E.repl ? 'async' : 'sync'],
    ]);
    return;
  }
  const n = findSel();
  const el = $('#live-node');
  if (!n || !el) return;
  const st = sim.ns.get(n.id);
  if (!st) { el.innerHTML = '<p class="muted">Press ▶ Run to see live numbers.</p>'; return; }
  const rows = [];
  const tot = st.in.r + st.in.w + st.in.s;
  rows.push(['Status', `<span class="st st-${st.status}">${(st.status || 'idle').toUpperCase()}</span>`]);
  if (n.type === 'client') {
    const m = sim.metrics;
    rows.push(['Sending', fmtRps(tot) + ' rps'], ['Success', pct(m.okRate)], ['Errors', pct(m.errRate)], ['p50 / p99', fmtMs(m.p50) + ' / ' + fmtMs(m.p99)]);
  } else {
    rows.push(['Incoming', `${fmtRps(tot)} rps <small>(${fmtRps(st.in.r)} r · ${fmtRps(st.in.w)} w${st.in.s ? ' · ' + fmtRps(st.in.s) + ' s' : ''})</small>`]);
    if (st.inRepl) rows.push(['Replication in', fmtRps(st.inRepl) + ' writes/s']);
    if (n.type === 'app' || n.type === 'worker') {
      rows.push(['Instances', `${st.instances}${st.pending.length ? ` (+${st.pending.length} booting)` : ''}`]);
      rows.push(['CPU', pct(st.cpu)], ['Threads busy', pct(st.threadUtil)], ['Capacity now', fmtRps(st.effCap) + ' rps'], ['Time per request', fmtMs(st.holdMs)]);
    } else if (!['cdn', 'dns', 'client'].includes(n.type)) rows.push(['Utilization', pct(st.util)]);
    if (n.type === 'cache' || n.type === 'cdn') rows.push(['Hit ratio', pct(st.hit)]);
    if (n.type === 'cache' && st.warmth < 1) rows.push(['Warmth', pct(st.warmth)]);
    if (n.type === 'replica') rows.push(['Replication lag', secs(st.lag)]);
    if (n.type === 'queue') rows.push(['Backlog', Math.round(st.qBacklog || 0).toLocaleString() + ' msgs'], ['Consumer lag', secs(st.qlag || 0)], ['Consuming', fmtRps(st.consumeRate || 0) + '/s']);
    if (n.type === 'gateway') rows.push(['Rejected (429)', pct(st.rejFrac)]);
    if (st.hotShare) rows.push(['Hottest partition share', pct(st.hotShare)]);
    if (st.backlog > 0) rows.push(['Queued work', Math.round(st.backlog).toLocaleString()]);
    rows.push(['Own latency p50/p99', fmtMs(Math.max(st.lat.r.p50, st.lat.w.p50, st.lat.s.p50)) + ' / ' + fmtMs(Math.max(st.lat.r.p99, st.lat.w.p99, st.lat.s.p99))]);
    const e = st.e2e;
    const domC = st.in.r >= st.in.w ? 'r' : 'w';
    rows.push(['End-to-end p99 (from here)', fmtMs(e[domC].p99)]);
    rows.push(['Dropped here', pct(st.dropFrac)]);
    rows.push(['Failing (incl. downstream)', pct(e[domC].err)]);
  }
  const ins = app.insights.filter(i => i.node === n.id);
  el.innerHTML = table(rows) + ins.map(i => insightHTML(i)).join('');
}

function table(rows) { return `<table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`; }

function insightHTML(i) {
  return `<div class="insight sev-${i.sev}"><b>${esc(i.title)}</b><p>${esc(i.text)}</p>${i.fix ? `<p class="fix">→ ${esc(i.fix)}</p>` : ''}</div>`;
}

function liveMetrics() {
  const sim = app.sim;
  const h = sim.history;
  const m = sim.history.length ? sim.rolling(2) : sim.metrics;
  const tiles = $('#tiles');
  if (!tiles) return;
  const tl = (l, v) => `<div class="tile"><span>${l}</span><b>${v}</b></div>`;
  tiles.innerHTML = tl('Offered', fmtRps(m.offered) + ' rps') + tl('Successful', fmtRps(m.goodput) + ' rps') + tl('p50', fmtMs(m.p50)) + tl('p99', fmtMs(m.p99)) + tl('Errors', pct(m.errRate)) + tl('Rejected', pct(m.rejRate)) + tl('Stale reads', pct(m.staleRate)) + tl('Cost', usd(m.cost) + '/mo') + (m.consumerLag > 0 ? tl('Consumer lag', secs(m.consumerLag)) : '') + (sim.metrics.lostWrites ? tl('Lost writes', Math.round(sim.metrics.lostWrites)) : '') + (sim.metrics.duplicates > 0.5 ? tl('Duplicates', Math.round(sim.metrics.duplicates)) : '');
  const pts = k => h.map(x => [x.t, x[k]]);
  const box = id => $(id);
  if (box('#ch-thr')) lineChart(box('#ch-thr'), [{ data: pts('offered'), color: '#64748b', fill: true }, { data: pts('goodput'), color: '#34d399' }], { fmt: x => fmtRps(x) });
  const p99goal = app.goals.find(g => g.metric === 'p99');
  if (box('#ch-lat')) lineChart(box('#ch-lat'), [{ data: pts('p50'), color: '#38bdf8' }, { data: pts('p99'), color: '#f472b6' }], { fmt: x => fmtMs(x), threshold: p99goal?.value });
  if (box('#ch-err')) lineChart(box('#ch-err'), [{ data: pts('errRate'), color: '#ef4444', fill: true }, { data: pts('rejRate'), color: '#fbbf24' }, { data: pts('staleRate'), color: '#a78bfa' }], { fmt: x => pct(x), min: 0.01 });
  if (box('#ch-cost')) lineChart(box('#ch-cost'), [{ data: pts('cost'), color: '#e2e8f0' }], { fmt: x => usd(x), height: 64 });
  const ins = $('#insights');
  if (ins) ins.innerHTML = app.insights.length ? app.insights.slice(0, 8).map(i => insightHTML({ ...i, title: (i.node ? nm(app.graph.nodes.find(n => n.id === i.node)) + ': ' : '') + i.title })).join('') : `<p class="muted">${sim.t > 0 ? 'All quiet. Nothing is struggling.' : 'Run the simulation to see diagnostics.'}</p>`;
  const log = $('#log');
  if (log) log.innerHTML = sim.log.slice(-60).reverse().map(l => `<div class="l lv-${l.level}"><span>${l.t.toFixed(1)}s</span>${esc(l.text)}</div>`).join('') || '<p class="muted">No events yet.</p>';
}

function liveTrace() {
  const el = $('#trace-body');
  if (!el) return;
  const sim = app.sim;
  const cls = app.traceCls || 'r';
  const client = app.graph.nodes.find(n => n.type === 'client');
  if (!client || !sim.ns.get(client.id) || sim.t === 0) { el.innerHTML = '<p class="muted">Run the simulation, then come back to see a request trace.</p>'; return; }
  const cst = sim.ns.get(client.id);
  if (!cst.offered[cls]) { el.innerHTML = `<p class="muted">These users send no ${{ r: 'reads', w: 'writes', s: 'static asset requests' }[cls]}.</p>`; return; }
  const spans = [];
  const walk = (n, start, depth, viaExtra, seen) => {
    if (depth > 12 || seen.has(n.id)) return 0;
    seen = new Set(seen).add(n.id);
    const st = sim.ns.get(n.id);
    if (!st) return 0;
    const own = n.type === 'client' ? 0 : st.lat[cls].p50;
    const idx = spans.length;
    spans.push({ n, start, own, dur: 0, depth, net: viaExtra, down: st.down, err: st.e2e[cls].err });
    let t = start + viaExtra + own;
    const outs = sim.outEdges(n).map(e => ({ e, E: sim.es.get(e.id), t: app.graph.nodes.find(x => x.id === e.to) })).filter(x => x.E && x.t && !x.E.repl && !(x.E.async && (cls === 'w' || n.type === 'queue')));
    const served = n.type === 'client' ? st.offered[cls] : st.served[cls];
    const call = n.type === 'app' || n.type === 'worker';
    const cands = outs.map(x => ({ ...x, share: served > 0 ? x.E.intended[cls] / served : 0 })).filter(x => x.share >= 0.05);
    if (call) for (const x of cands) t += walk(x.t, t, depth + 1, x.E.extraMs || 0, seen);
    else if (cands.length) {
      const best = cands.sort((a, b) => b.share - a.share)[0];
      if (best.share >= 0.5 || n.type !== 'cache') t += walk(best.t, t, depth + 1, best.E.extraMs || 0, seen);
    }
    spans[idx].dur = t - start;
    return t - start;
  };
  walk(client, 0, 0, 0, new Set());
  const total = Math.max(1, ...spans.map(s => s.start + s.dur));
  el.innerHTML = `<div class="tr-total">Median end-to-end: <b>${fmtMs(cst.e2e[cls].p50)}</b> · p99 <b>${fmtMs(cst.e2e[cls].p99)}</b> · fails <b>${pct(cst.e2e[cls].err)}</b></div>` +
    spans.map(s => {
      const def = CATALOG[s.n.type];
      const left = (s.start / total) * 100, width = Math.max(0.6, (s.dur / total) * 100);
      const netW = (s.net / total) * 100, ownW = (s.own / total) * 100;
      return `<div class="span ${s.down ? 'down' : ''}" style="--d:${s.depth}"><div class="sp-name"><span>${def.icon}</span>${esc(nm(s.n))}</div>
        <div class="sp-bar"><div class="sp-all" style="left:${left}%;width:${width}%;--c:${def.color}">${s.net ? `<i class="net" style="width:${(netW / width) * 100}%"></i>` : ''}<i class="own" style="width:${(ownW / width) * 100}%"></i></div></div>
        <div class="sp-ms">${fmtMs(s.dur)}</div></div>`;
    }).join('') + '<p class="muted small">Grey = network hop, solid = time spent inside the component, light = waiting on downstream calls.</p>';
}

// ---------------------------------------------------------------- modals & toasts
function modal(html, bind) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal"><button class="modal-x" data-close>✕</button>${html}</div>`;
  m.classList.add('open');
  m.onclick = e => { if (e.target === m || e.target.closest('[data-close]')) closeModal(); };
  bind?.(m);
}
function closeModal() { $('#modal').classList.remove('open'); }

function toast(text, kind = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = text;
  $('#toasts').appendChild(t);
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}

function showWelcome() {
  modal(`<div class="welcome">
    <div class="logo-big">◆</div>
    <h1>Learn system design by breaking things</h1>
    <p>Backpressure is a hands-on 12-week course. Each lesson explains a concept in depth, then drops you into a <b>live simulation</b>: build the architecture, push real traffic through it, inject failures, and watch what breaks.</p>
    <div class="how">
      <div><b>1 · Build</b><span>Drag components in. Connect them from the ● on the right edge.</span></div>
      <div><b>2 · Run</b><span>Press ▶ (or Space). Dots are requests: blue reads, amber writes, red failures.</span></div>
      <div><b>3 · Break</b><span>💥 Chaos and right-click menus kill servers, cut networks and spike traffic.</span></div>
      <div><b>4 · Pass</b><span>Each lab has goals (latency, errors, cost). Hold them for the whole run.</span></div>
    </div>
    <div class="modal-actions"><button class="btn primary" data-close>Start learning</button></div>
  </div>`);
  store.set('welcomed', true);
}

boot();
