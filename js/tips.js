// Explain-on-hover: any element with data-tip="key" (see glossary.js) or
// data-tip-text="plain text" shows a small card after a short hover.
//
// Many panels re-render several times a second, so the tip follows whatever
// element is under the pointer with the same key, not one DOM node.

import { TIPS, COMPONENT_TIPS } from './glossary.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SEL = '[data-tip], [data-tip-text]';
const keyOf = el => (el ? el.dataset.tip || 'text:' + el.dataset.tipText : null);

function content(el) {
  const key = el.dataset.tip;
  if (key) {
    const entry = key.startsWith('c:') ? COMPONENT_TIPS[key.slice(2)] : TIPS[key];
    if (entry) return `<b>${entry[0]}</b><span>${entry[1]}</span>`;
  }
  const text = el.dataset.tipText;
  if (text) return `${el.dataset.tipTitle ? `<b>${esc(el.dataset.tipTitle)}</b>` : ''}<span>${esc(text)}</span>`;
  return null;
}

export function initTips() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let key = null, timer = 0, poll = 0, pressed = false, px = -1, py = -1, pinned = false;

  const under = () => document.elementFromPoint(px, py)?.closest(SEL) || null;
  const hide = () => { clearTimeout(timer); clearInterval(poll); key = null; pinned = false; tip.classList.remove('show'); };
  const place = el => {
    // SVG links can span the whole canvas: anchor those at the pointer instead.
    const r = el instanceof SVGElement ? { left: px, top: py - 6, bottom: py + 6, width: 0 } : el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.top - th - 8;
    if (y < 8) y = r.bottom + 8; // no room above: show below
    tip.style.left = Math.max(8, Math.min(innerWidth - tw - 8, x)) + 'px';
    tip.style.top = Math.max(8, Math.min(innerHeight - th - 8, y)) + 'px';
  };
  const show = el => {
    const html = content(el);
    if (!html) return hide();
    if (tip.innerHTML !== html) tip.innerHTML = html;
    tip.classList.add('show');
    place(el);
    clearInterval(poll);
    // keep following the element (it may be re-rendered) until the pointer leaves it
    poll = setInterval(() => {
      if (pinned) return;
      const el2 = under();
      if (!el2 || keyOf(el2) !== key) return hide();
      place(el2);
    }, 250);
  };
  const consider = () => {
    if (pressed || pinned) return;
    const el = under();
    const k = keyOf(el);
    if (k === key) return;
    hide();
    if (!el) return;
    key = k;
    timer = setTimeout(() => { const now = under(); if (now && keyOf(now) === key) show(now); }, el.closest('.node, .edge, .kpis') ? 450 : 250);
  };

  document.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    px = e.clientX; py = e.clientY;
    consider();
  }, { passive: true });
  document.addEventListener('pointerleave', hide);
  // Never get in the way of dragging, panning or wiring.
  document.addEventListener('pointerdown', e => {
    pressed = true;
    // On touch (or click), a help icon toggles its explanation.
    const help = e.target.closest('.help');
    if (help && e.pointerType === 'touch') {
      e.preventDefault();
      if (pinned && key === keyOf(help)) return hide();
      hide(); key = keyOf(help); pinned = true; show(help);
      return;
    }
    hide();
  }, true);
  document.addEventListener('pointerup', () => { pressed = false; }, true);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  // Keyboard users: explain focused help icons too.
  document.addEventListener('focusin', e => { const el = e.target.closest?.('.help'); if (el) { hide(); key = keyOf(el); pinned = true; show(el); } });
  document.addEventListener('focusout', e => { if (e.target.closest?.('.help')) hide(); });
}
