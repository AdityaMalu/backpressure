// Tiny SVG line charts for live metrics.

export function lineChart(el, series, opts = {}) {
  const W = el.clientWidth || 300;
  const H = opts.height || 84;
  const pad = { l: 38, r: 8, t: 8, b: 16 };
  const all = series.flatMap(s => s.data.map(d => d[1])).filter(v => isFinite(v));
  let max = Math.max(opts.min ?? 0, ...(all.length ? all : [1]));
  if (opts.max != null) max = Math.max(opts.max, max);
  if (opts.fixedMax != null) max = opts.fixedMax;
  if (max <= 0) max = 1;
  const xs = series.flatMap(s => s.data.map(d => d[0]));
  const x0 = Math.min(...(xs.length ? xs : [0])), x1 = Math.max(...(xs.length ? xs : [1]), x0 + 1);
  const sx = x => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const sy = y => pad.t + (1 - Math.min(y, max) / max) * (H - pad.t - pad.b);
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="chart">`;
  for (const f of [0, 0.5, 1]) {
    const y = sy(max * f);
    s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" class="grid"/>`;
    s += `<text x="${pad.l - 5}" y="${y + 3}" text-anchor="end" class="axis">${(opts.fmt || String)(max * f)}</text>`;
  }
  if (opts.threshold != null) {
    const y = sy(opts.threshold);
    s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" class="threshold"/>`;
  }
  for (const se of series) {
    if (!se.data.length) continue;
    const pts = se.data.map(d => `${sx(d[0]).toFixed(1)},${sy(d[1]).toFixed(1)}`).join(' ');
    if (se.fill) s += `<polygon points="${sx(se.data[0][0])},${sy(0)} ${pts} ${sx(se.data[se.data.length - 1][0])},${sy(0)}" fill="${se.color}" opacity="0.12"/>`;
    s += `<polyline points="${pts}" fill="none" stroke="${se.color}" stroke-width="1.8" stroke-linejoin="round"/>`;
  }
  s += `<text x="${pad.l}" y="${H - 3}" class="axis">${Math.round(x0)}s</text><text x="${W - pad.r}" y="${H - 3}" text-anchor="end" class="axis">${Math.round(x1)}s</text>`;
  s += '</svg>';
  el.innerHTML = s;
}
