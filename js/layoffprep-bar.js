/* layoffprep bar: a slim strip linking this tool to the layoffprep hub, the other tools, and a few topics to try next.
   Same file in every tool repo. Set data-tool on the script tag: algo | lc | java | db | os | sd | lab.
   It does nothing when the page is embedded in the hub, which already has its own tabs. */
(function () {
  if (window.top !== window.self) return;
  var me = document.currentScript, tool = me && me.getAttribute('data-tool');
  var HUB = 'https://layoffprep.pages.dev/';
  var TOOLS = [
    ['algo', 'AlgoScope'], ['lc', 'LeetCode'], ['java', 'Java'], ['db', 'DB'], ['os', 'OS'], ['sd', 'System Design'], ['lab', 'Machine Coding']
  ];
  // [label, tool, hash or sub-path]
  var NEXT = {
    algo: [['Amazon problems, most asked first', 'lc', '#amazon'], ['Cache stampede: how a hot key melts a database', 'sd', '#/caching'], ['Build a token-bucket rate limiter', 'lab', '&p=p/rate-limiter']],
    lc: [['Trace Trapping Rain Water step by step', 'algo', '#trapping-rain-water'], ['Trace Sliding Window Maximum', 'algo', '#sliding-window-maximum'], ['Build a TTL + LRU cache', 'lab', '&p=p/ttl-lru-cache']],
    java: [['MVCC: how databases read without locking', 'db', '#t6-5'], ['Condition variables in the OS', 'os', '#t4-5'], ['Retry with backoff in a job queue', 'lab', '&p=p/job-queue']],
    db: [['CAP theorem in system design', 'sd', '#/cap'], ['@Transactional in Spring', 'java', '#t5-4'], ['Why caches stampede', 'sd', '#/caching']],
    os: [['volatile and the Java memory model', 'java', '#t4-6'], ['Write-ahead logging in databases', 'db', '#t7-1'], ["Little's law and thread pools", 'sd', '#/latency-throughput']],
    sd: [['Consistent hashing in databases', 'db', '#t8-4'], ['epoll and event loops', 'os', '#t9-2'], ['Build a token-bucket rate limiter', 'lab', '&p=p/rate-limiter']],
    lab: [['CompletableFuture in Java', 'java', '#t4-14'], ['Trace Sliding Window Maximum', 'algo', '#sliding-window-maximum'], ['Circuit breakers in system design', 'sd', '#/resilience']]
  };
  var href = function (key, extra) {
    extra = extra || '';
    return HUB + '?a=' + key + (extra.charAt(0) === '&' ? extra : '') + (extra.charAt(0) === '#' ? extra : '');
  };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var css = '.lpbar{--lp-bg:#11202b;--lp-line:#253b4a;--lp-text:#c7d3dc;--lp-bright:#eef3f6;--lp-accent:#f2b880;position:relative;z-index:50;display:flex;align-items:center;gap:6px;height:34px;box-sizing:border-box;padding:0 max(12px,env(safe-area-inset-right,0px)) 0 max(12px,env(safe-area-inset-left,0px));background:var(--lp-bg);border-bottom:1px solid var(--lp-line);color:var(--lp-text);font:13px/1 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.lpbar a,.lpbar button{font:inherit;color:inherit;text-decoration:none;background:none;border:0;cursor:pointer}' +
    '.lpbar :focus-visible{outline:2px solid var(--lp-accent);outline-offset:1px;border-radius:4px}' +
    '.lpbrand{flex:none;font-weight:700;color:var(--lp-bright)!important;padding:6px 8px 6px 0;letter-spacing:.01em}.lpbrand b{color:var(--lp-accent)}' +
    '.lpnav{flex:1;min-width:0;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}.lpnav::-webkit-scrollbar{display:none}' +
    '.lpnav a{flex:none;padding:6px 9px;border-radius:6px;white-space:nowrap}.lpnav a:hover{color:var(--lp-bright);background:rgba(242,184,128,.12)}' +
    '.lpnav a[aria-current="page"]{color:var(--lp-accent);background:rgba(242,184,128,.12);font-weight:600}' +
    '.lpnext{flex:none;padding:6px 8px;border-radius:6px;color:var(--lp-accent)!important;font-weight:600}.lpnext:hover{background:rgba(242,184,128,.12)}' +
    '.lppop{position:absolute;right:max(8px,env(safe-area-inset-right,0px));top:38px;width:min(320px,calc(100vw - 16px));box-sizing:border-box;padding:6px;background:var(--lp-bg);border:1px solid var(--lp-line);border-radius:10px;box-shadow:0 14px 36px rgba(0,0,0,.4)}' +
    '.lppop[hidden]{display:none}.lppop h2{margin:0;padding:8px 10px 6px;font:600 11px/1 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--lp-accent)}' +
    '.lppop a{display:block;padding:9px 10px;border-radius:6px;color:var(--lp-text);line-height:1.35}.lppop a:hover{background:rgba(242,184,128,.12);color:var(--lp-bright)}.lppop a small{display:block;margin-top:2px;color:#8497a6;font-size:11.5px}' +
    '.lppop .lpall{border-top:1px solid var(--lp-line);margin-top:4px;border-radius:0 0 6px 6px;color:var(--lp-accent)}' +
    '@media(max-width:560px){.lpbrand span{display:none}}' +
    /* tools that fill the screen: keep the page from scrolling by the bar's height */
    'html.lp-on .app{min-height:calc(100vh - 34px)}html.lp-on .rail{height:calc(100vh - 34px)}';

  function build() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    var bar = document.createElement('div');
    bar.className = 'lpbar';
    bar.setAttribute('role', 'navigation');
    bar.setAttribute('aria-label', 'layoffprep');
    var nav = TOOLS.map(function (t) {
      return '<a href="' + href(t[0]) + '"' + (t[0] === tool ? ' aria-current="page"' : '') + '>' + esc(t[1]) + '</a>';
    }).join('');
    var next = NEXT[tool] || [];
    var map = {}; TOOLS.forEach(function (t) { map[t[0]] = t[1]; });
    var pop = next.map(function (n) {
      return '<a href="' + href(n[1], n[2]) + '">' + esc(n[0]) + '<small>in ' + esc(map[n[1]]) + '</small></a>';
    }).join('');
    bar.innerHTML = '<a class="lpbrand" href="' + HUB + '" title="All the interview prep tools">layoff<b>prep</b></a>' +
      '<div class="lpnav">' + nav + '</div>' +
      (next.length ? '<button type="button" class="lpnext" aria-expanded="false" aria-controls="lppop">Next up ▾</button>' +
        '<div class="lppop" id="lppop" hidden><h2>Try next</h2>' + pop + '<a class="lpall" href="' + HUB + '">See all tools on layoffprep →</a></div>' : '');
    document.body.insertBefore(bar, document.body.firstChild);
    document.documentElement.classList.add('lp-on');
    var btn = bar.querySelector('.lpnext'), box = bar.querySelector('.lppop');
    if (!btn) return;
    var close = function () { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = box.hidden;
      box.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', function (e) { if (!bar.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }
  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
})();
