// Back-of-the-envelope capacity estimator, the first 5 minutes of every
// system design interview.

const DEFAULTS = {
  dau: 10_000_000, readsPerUser: 20, writesPerUser: 2, recordKB: 1,
  mediaPerUser: 0, mediaKB: 500, peak: 3, years: 5, replication: 3, serverRps: 1000,
};

const FIELDS = [
  ['dau', 'Daily active users', 1],
  ['readsPerUser', 'Reads per user per day', 1],
  ['writesPerUser', 'Writes per user per day', 1],
  ['recordKB', 'Size of one write (KB)', 0.1],
  ['mediaPerUser', 'Media uploads per user per day', 0.01],
  ['mediaKB', 'Avg media size (KB)', 1],
  ['peak', 'Peak / average traffic', 0.5],
  ['years', 'Retention (years)', 1],
  ['replication', 'Replication factor', 1],
  ['serverRps', 'Requests one server handles', 100],
];

const fmtN = x => x >= 1e9 ? (x / 1e9).toFixed(1) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : x.toFixed(x < 10 ? 1 : 0);
const fmtB = kb => { const b = kb * 1024; const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']; let i = 0, v = b; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return v.toFixed(v < 10 ? 1 : 0) + ' ' + u[i]; };

// The numbers behind the calculator, also used to grade interview estimates.
export function estimate(preset) {
  const v = { ...DEFAULTS, ...preset };
  const S = 86400;
  const rAvg = (v.dau * v.readsPerUser) / S;
  const wAvg = (v.dau * v.writesPerUser) / S;
  const mAvg = (v.dau * v.mediaPerUser) / S;
  const rPeak = rAvg * v.peak, wPeak = wAvg * v.peak;
  const perDayKB = v.dau * (v.writesPerUser * v.recordKB + v.mediaPerUser * v.mediaKB);
  const totalKB = perDayKB * 365 * v.years * v.replication;
  const egressKBs = (rAvg * v.recordKB) + (mAvg * v.mediaKB * Math.max(1, v.readsPerUser / Math.max(1, v.writesPerUser)));
  const ingressKBs = perDayKB / S;
  const cacheKB = v.dau * v.readsPerUser * v.recordKB * 0.2;
  const servers = Math.ceil((rPeak + wPeak) / v.serverRps);
  return { v, rAvg, wAvg, rPeak, wPeak, peakQps: rPeak + wPeak, ratio: v.writesPerUser ? v.readsPerUser / v.writesPerUser : Infinity, perDayKB, yearKB: perDayKB * 365, totalKB, egressKBs, ingressKBs, cacheKB, servers };
}

export { fmtN, fmtB };

export function renderCalculator(el, preset) {
  const v = { ...DEFAULTS, ...(typeof preset === 'object' ? preset : {}) };
  el.innerHTML = `<section class="calc"><h2>🧮 Back-of-the-envelope calculator</h2>
    <p class="muted">Change the inputs and watch the numbers move. In interviews, round aggressively: 1 day ≈ 10⁵ seconds.</p>
    <div class="calc-grid">${FIELDS.map(([k, l, s]) => `<label><span>${l}</span><input type="number" data-c="${k}" value="${v[k]}" step="${s}" min="0"></label>`).join('')}</div>
    <div class="calc-out"></div></section>`;
  const out = el.querySelector('.calc-out');
  const update = () => {
    const { rAvg, wAvg, rPeak, wPeak, perDayKB, totalKB, egressKBs, ingressKBs, cacheKB, servers } = estimate(v);
    const rows = [
      ['Average reads', fmtN(rAvg) + ' /s'],
      ['Average writes', fmtN(wAvg) + ' /s'],
      ['Peak QPS (reads + writes)', fmtN(rPeak + wPeak) + ' /s'],
      ['Read : write ratio', (v.writesPerUser ? (v.readsPerUser / v.writesPerUser).toFixed(0) : '∞') + ' : 1'],
      ['New data per day', fmtB(perDayKB)],
      [`Storage for ${v.years}y × RF${v.replication}`, fmtB(totalKB)],
      ['Ingress bandwidth', fmtB(ingressKBs) + '/s'],
      ['Egress bandwidth (approx.)', fmtB(egressKBs) + '/s'],
      ['Cache for hottest 20% of daily reads', fmtB(cacheKB)],
      ['App servers at peak', servers + ` (+ headroom → ${Math.ceil(servers * 1.5)})`],
    ];
    out.innerHTML = `<table class="kv">${rows.map(([a, b]) => `<tr><td>${a}</td><td><b>${b}</b></td></tr>`).join('')}</table>`;
  };
  el.querySelectorAll('[data-c]').forEach(inp => inp.addEventListener('input', () => { v[inp.dataset.c] = +inp.value || 0; update(); }));
  update();
}
