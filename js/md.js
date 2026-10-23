// Minimal markdown renderer for lesson content (headings, lists, tables,
// code, blockquotes, emphasis, links). Content is first-party, but we still
// escape HTML so nothing in a lesson can inject markup.

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

export function md(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  let html = '';
  let i = 0;
  const isBlank = l => !l.trim();
  while (i < lines.length) {
    let l = lines[i];
    if (isBlank(l)) { i++; continue; }
    if (l.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const lv = h[1].length + 1; html += `<h${lv}>${inline(h[2])}</h${lv}>`; i++; continue; }
    if (/^---+\s*$/.test(l)) { html += '<hr>'; i++; continue; }
    if (l.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      const body = buf.join('\n');
      const kind = (body.match(/^\*\*(Tip|Interview|Warning|Try it|Numbers|Pitfall|Key idea)/i) || [])[1];
      html += `<blockquote class="${kind ? 'bq-' + kind.toLowerCase().replace(/\s/g, '') : ''}">${md(body)}</blockquote>`;
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = row(l);
      i += 2;
      let body = '';
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
        body += '<tr>' + row(lines[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
        i++;
      }
      html += `<div class="table-wrap"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      html += list(lines, i, out => { i = out; });
      continue;
    }
    const buf = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s+)/.test(lines[i])) buf.push(lines[i++]);
    html += `<p>${inline(buf.join(' '))}</p>`;
  }
  return html;
}

function list(lines, i, done) {
  const indent = l => l.match(/^\s*/)[0].length;
  const base = indent(lines[i]);
  const ordered = /^\s*\d+\./.test(lines[i]);
  let html = ordered ? '<ol>' : '<ul>';
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { if (i + 1 < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i + 1]) && indent(lines[i + 1]) >= base) { i++; continue; } break; }
    const ind = indent(l);
    const m = l.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (ind < base) break;
    if (ind > base && m) {
      html = html.replace(/<\/li>$/, '');
      html += list(lines, i, out => { i = out; }) + '</li>';
      continue;
    }
    if (!m) {
      if (ind > base) { html = html.replace(/<\/li>$/, ' ' + inline(l.trim()) + '</li>'); i++; continue; }
      break;
    }
    html += `<li>${inline(m[2])}</li>`;
    i++;
  }
  done(i);
  return html + (ordered ? '</ol>' : '</ul>');
}
