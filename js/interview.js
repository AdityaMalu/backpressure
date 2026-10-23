// Interview practice: a timed 45-minute system design round built on the
// week 11–12 case studies. Requirements → estimates → design → score report.
// This module holds the content, grading and step views; main.js wires it to
// the canvas, the simulator and storage.
import { md } from './md.js';
import { esc } from './editor.js';
import { estimate, fmtN as fmtN1, fmtB } from './calculator.js';
import { findLesson } from './curriculum/index.js';

export const ROUND_SEC = 45 * 60;
export const IV_IDS = ['url-shortener', 'whatsapp', 'instagram', 'youtube', 'uber', 'payments', 'notifications'];
const fmtN = x => fmtN1(x).replace(/\.0(?=[kMB]$)/, '');
const WEIGHTS = { req: 0.25, est: 0.25, design: 0.5 };

// Requirement checklists: [group, relevant, text, why]. group F = functional,
// N = non-functional. relevant=false marks a distractor: something a strong
// candidate would not ask for or commit to.
const REQS = {
  'url-shortener': [
    ['F', true, 'Create a short code for a long URL (optional custom alias)', 'The write path: the reason the product exists.'],
    ['F', true, 'Redirect a short code to its long URL', 'The read path: ~100× the volume of creates, so it drives the design.'],
    ['F', true, 'Links can expire', 'Shapes the data model (expires_at) and needs a sweeper or lazy deletion.'],
    ['F', true, 'Click analytics per link', 'Decides 301 vs 302 and pushes you to an async event pipeline.'],
    ['F', false, 'Anyone can edit the destination of any existing short link', 'Out of scope, and mutable targets fight edge caching of redirects.'],
    ['F', false, 'Full-text search across every shortened URL', 'Not part of the product; it would add a search cluster for nothing.'],
    ['N', true, 'Redirect p99 well under 100 ms server-side', 'Every click pays it; this is why caches and the edge matter.'],
    ['N', true, 'Redirects highly available (a dead link breaks the product)', 'Availability beats consistency on the read path.'],
    ['N', true, 'Read-heavy: about 100 reads per write', 'The ratio tells you to optimize reads: cache + CDN.'],
    ['N', true, 'Codes unique and not guessable in sequence', 'Drives the ID-generation deep dive (ranges, Snowflake, key pool).'],
    ['N', false, 'Strong consistency for redirects across all regions', 'A new link taking a moment to propagate is fine. Strong consistency would cost latency for no user benefit.'],
    ['N', false, 'Exactly-once click counting, visible instantly', 'Approximate, slightly delayed analytics are the norm; exactness would put a counter on the hot path.'],
  ],
  whatsapp: [
    ['F', true, '1:1 and group chat (groups up to ~1,000)', 'The core feature; group size sets the fan-out cost.'],
    ['F', true, 'Delivery and read receipts', 'Needs per-message state and acks flowing back to the sender.'],
    ['F', true, 'Offline delivery on reconnect, with a push notification meanwhile', 'Requires a durable inbox and a push path (APNs/FCM).'],
    ['F', true, 'Online / last-seen presence', 'High-volume, ephemeral state: in-memory with TTLs.'],
    ['F', true, 'Media messages (photos, video)', 'Bytes go to object storage + CDN; only references travel in messages.'],
    ['F', false, 'Server-side full-text search of message contents', 'With end-to-end encryption the server cannot read messages.'],
    ['N', true, 'No message loss: persist before acking the sender', 'The ✓ must mean "durably stored".'],
    ['N', true, 'Messages ordered within each conversation', 'Partition by conversation_id and sequence there.'],
    ['N', true, 'Low delivery latency (< ~200 ms when both are online)', 'Drives persistent connections instead of polling.'],
    ['N', true, 'End-to-end encryption', 'The server stores ciphertext only, which constrains features like search.'],
    ['N', false, 'A single global order across all messages in all chats', 'Impossible to scale and unnecessary: per-conversation order is what users see.'],
    ['N', false, 'Strongly consistent presence and last-seen', 'Presence can be seconds stale; making it strongly consistent is pure cost.'],
  ],
  instagram: [
    ['F', true, 'Upload photos/videos with captions', 'The write path: direct-to-storage uploads, async processing.'],
    ['F', true, 'Follow and unfollow users', 'The social graph that feeds are built from.'],
    ['F', true, 'Home feed of followed accounts’ posts', 'The heart of the question: fan-out on write vs read.'],
    ['F', true, 'Likes and comments', 'Hot counters on celebrity posts need sharding or async aggregation.'],
    ['F', false, 'A full in-app video editing suite', 'A client feature, out of scope for the backend design.'],
    ['F', false, 'Purely chronological feed, globally ordered across all users', 'Feeds are per-user and ranked; a global order is neither needed nor feasible.'],
    ['N', true, 'Feed loads fast (< ~300 ms server time)', 'Pushes you to precomputed timelines in a cache.'],
    ['N', true, 'Media loads fast worldwide', 'CDN + object storage; bandwidth dominates cost.'],
    ['N', true, 'Eventual consistency is fine (posts appear within seconds)', 'Allows async fan-out workers.'],
    ['N', true, 'Very read-heavy, with celebrity hot keys', 'Caching, request coalescing and the hybrid fan-out follow from this.'],
    ['N', false, 'Every follower sees a new post within 10 ms', 'Unnecessary, and impossible for accounts with 300M followers.'],
    ['N', false, 'Like counts exact and identical for every viewer in real time', 'Approximate counts are fine; exactness creates a write hot spot.'],
  ],
  youtube: [
    ['F', true, 'Upload videos (resumable)', 'Large files over flaky networks: chunked, resumable uploads to object storage.'],
    ['F', true, 'Smooth playback on any device and network', 'Adaptive bitrate streaming (HLS/DASH) over multiple renditions.'],
    ['F', true, 'View counts, likes and comments', 'Counters at huge volume: aggregate events asynchronously.'],
    ['F', true, 'Search and recommendations (scoped as separate systems)', 'Worth naming and scoping out so the round focuses on upload + playback.'],
    ['F', false, 'Transcoding finishes before the upload request returns', 'Transcoding takes minutes; it belongs in an async pipeline.'],
    ['F', false, 'One quality level for every viewer, to keep things simple', 'Breaks playback on weak networks; adaptive bitrate is a core requirement.'],
    ['N', true, 'Playback starts within ~2 s and doesn’t stall', 'Small segments, CDN edges, adaptive quality.'],
    ['N', true, 'Uploads may take minutes to process', 'Lets you use a queue + transcoding worker fleet.'],
    ['N', true, 'Global audience; bandwidth is the dominant cost', 'CDN hit ratio and codecs matter more than server count.'],
    ['N', true, 'Very high availability of playback', 'Immutable segments replicate easily to many edges.'],
    ['N', false, 'View counts exact and updated synchronously on every view', 'A hot row updated millions of times a minute; stream and aggregate instead.'],
    ['N', false, 'Strong consistency for like counts worldwide', 'Eventual consistency is fine for engagement counters.'],
  ],
  uber: [
    ['F', true, 'Riders request a ride and see nearby drivers', 'Needs a geospatial query over live driver positions.'],
    ['F', true, 'Match a rider with a nearby available driver', 'The dispatch service: rank by ETA, offer, time out.'],
    ['F', true, 'Drivers report their location every few seconds', 'The write firehose: ~1M+ updates/s globally.'],
    ['F', true, 'Live trip tracking, ETA and pricing (surge)', 'Streams of location data feed tracking and per-cell surge.'],
    ['F', true, 'Trip history and payments', 'Durable, transactional stores, separate from the live index.'],
    ['F', false, 'Match purely on straight-line distance', 'Road-network ETA is what matters; straight-line picks the driver across the river.'],
    ['N', true, 'Matching within ~1 s', 'In-memory geo index sharded by cell or city.'],
    ['N', true, 'Location writes are huge, ephemeral, and only the latest matters', 'Memory-first; durable history in batches.'],
    ['N', true, 'A driver can never be assigned two rides', 'Atomic compare-and-set on driver state.'],
    ['N', true, 'Stay available through demand peaks (concerts, rain)', 'Headroom and fine-grained geo sharding for hot spots.'],
    ['N', false, 'Persist every GPS ping durably before acking it', 'Losing a ping is harmless; synchronous durability would need a huge database.'],
    ['N', false, 'Globally strongly consistent driver locations', 'Positions are stale within seconds anyway; strong consistency adds latency for nothing.'],
  ],
  payments: [
    ['F', true, 'Accept payments through external PSPs (Stripe, Adyen, banks)', 'The core flow, through unreliable third parties.'],
    ['F', true, 'Refunds', 'New ledger entries and state transitions, never edits.'],
    ['F', true, 'Payment status, history and merchant webhooks', 'An outbox to publish events reliably.'],
    ['F', true, 'Payouts to sellers', 'Money out: the ledger must account for it.'],
    ['F', false, 'Retry failed PSP calls immediately with a fresh request', 'A timeout is an unknown outcome; a fresh request can double charge.'],
    ['F', false, 'Store raw card numbers so customers can pay with one click', 'Never: tokenize via the PSP/vault to stay out of PCI scope.'],
    ['N', true, 'Never double-charge (idempotency)', 'Idempotency keys on clients, API and PSP calls.'],
    ['N', true, 'Never lose a payment: durable, strongly consistent storage', 'ACID database with synchronous replication.'],
    ['N', true, 'Fully auditable money movements', 'Append-only double-entry ledger plus reconciliation.'],
    ['N', true, 'Handle PSP timeouts and unknown outcomes', 'Same-key retries, status queries, webhooks, reconciliation.'],
    ['N', false, 'Millions of transactions per second', 'Payment volume is modest (hundreds to thousands TPS); correctness is the hard part.'],
    ['N', false, 'Eventual consistency for balances is fine', 'Not for money: balances and state transitions need strong consistency.'],
  ],
  notifications: [
    ['F', true, 'Multiple channels: push, email, SMS, in-app', 'Per-channel queues and workers, sized to each provider.'],
    ['F', true, 'User preferences, opt-outs and quiet hours', 'Checked in the routing step before anything is sent.'],
    ['F', true, 'Templates and localization', 'Rendered by the routing service, versioned in a store.'],
    ['F', true, 'Priorities: transactional (OTP) vs marketing', 'Separate lanes so a campaign never delays a login code.'],
    ['F', true, 'Delivery tracking', 'Delivery/open events into analytics; dead tokens cleaned up.'],
    ['F', false, 'Deliver inside the producer’s API call', 'Synchronous delivery couples producers to slow providers; enqueue instead.'],
    ['N', true, 'Absorb bursts (a broadcast to millions)', 'Queues turn bursts into backlog.'],
    ['N', true, 'Respect provider rate limits and quotas', 'Worker pools sized under each quota, with token buckets.'],
    ['N', true, 'At-least-once delivery with dedupe', 'Notification IDs as idempotency keys stop double-notifying.'],
    ['N', true, 'Low latency for transactional messages; channels isolated', 'Priority lanes and per-channel workers.'],
    ['N', false, 'Guaranteed exactly-once delivery to every device', 'Impossible end to end (providers can deliver twice); dedupe where you can.'],
    ['N', false, 'A 50M-user broadcast delivered within one second', 'Unrealistic under provider quotas and unnecessary for marketing.'],
  ],
};

// ---------------------------------------------------------------- attempt state
// A deterministic shuffle per attempt so the checklist order survives a reload.
function shuffled(n, seed) {
  const a = [...Array(n).keys()];
  let s = seed % 2147483647 || 1;
  for (let i = n - 1; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function newAttempt(id) {
  const startedAt = Date.now();
  return { id, step: 'req', startedAt, seed: startedAt % 100000 + 7, picks: [], reqResult: null, est: {}, estResult: null, result: null };
}

export function remainingSec(iv, now = Date.now()) {
  return ROUND_SEC - ((iv.submittedAt || now) - iv.startedAt) / 1000;
}
export const clockLabel = (iv, rem) => (iv.submittedAt ? 'Time used' : rem < 0 ? 'Overtime' : 'Time left');
export function clockText(sec) {
  const s = Math.abs(Math.round(sec));
  const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return sec < 0 ? `+${t}` : t;
}

// The canvas the candidate starts from: the users, plus third-party providers
// that the scenario names (you can't design APNs or a PSP, only call them).
export function startingGraph(L) {
  const g = L.lab.graph;
  const keep = g.nodes.filter(n => n.type === 'client' || n.type === 'external');
  return JSON.parse(JSON.stringify({ nodes: keep, edges: [] }));
}

// ---------------------------------------------------------------- grading
export function gradeReqs(id, picks) {
  const items = REQS[id];
  const set = new Set(picks);
  const relevant = items.map((x, i) => i).filter(i => items[i][1]);
  const hits = relevant.filter(i => set.has(i));
  const missed = relevant.filter(i => !set.has(i));
  const wrong = picks.filter(i => !items[i][1]);
  const score = Math.max(0, (hits.length - wrong.length) / relevant.length);
  return { score, hits: hits.length, total: relevant.length, missed, wrong };
}

// Accept "35k", "3.5M", "35,000", "1e6".
export function parseCount(str) {
  const m = String(str || '').replace(/[,_\s]/g, '').match(/^(\d*\.?\d+(?:e[+-]?\d+)?)([kmb])?(?:\/s|qps|rps)?$/i);
  if (!m) return NaN;
  return +m[1] * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1);
}
const UNIT_KB = { GB: 1024 ** 2, TB: 1024 ** 3, PB: 1024 ** 4 };

function band(given, expected) {
  if (!(given > 0) || !(expected > 0)) return { factor: Infinity, grade: 'off', pass: false };
  const factor = Math.max(given / expected, expected / given);
  return { factor, grade: factor <= 2 ? 'close' : factor <= 10 ? 'ok' : 'off', pass: factor <= 10 };
}
const times = x => (x >= 100 ? Math.round(x) : x >= 10 ? x.toFixed(0) : x.toFixed(1)) + '×';
const ratioText = r => (r >= 1 ? `${r >= 10 ? Math.round(r) : +r.toFixed(1)} : 1` : `1 : ${1 / r >= 10 ? Math.round(1 / r) : +(1 / r).toFixed(1)}`);
const num = x => (x >= 1e6 ? fmtN(x) : (+x.toPrecision(3)).toLocaleString('en-US'));

export function scaleFacts(L) {
  const v = estimate(L.calculator).v;
  const facts = [
    `**${fmtN(v.dau)}** daily active users`,
    `Each user does about **${num(v.readsPerUser)} reads** and **${num(v.writesPerUser)} writes** a day`,
    `One write stores about **${fmtB(v.recordKB)}**`,
  ];
  if (v.mediaPerUser) facts.push(`Users upload **${num(v.mediaPerUser)} media files** a day each, about **${fmtB(v.mediaKB)}** per file (all renditions)`);
  facts.push(`Peak traffic is about **${v.peak}×** the daily average`, `Data is replicated **${v.replication}×**`);
  return facts;
}

export function gradeEstimates(L, input) {
  const e = estimate(L.calculator);
  const v = e.v;
  const qps = parseCount(input.qps);
  const ratio = (+input.r > 0 && +input.w > 0) ? +input.r / +input.w : NaN;
  const storeKB = (+input.storage > 0 ? +input.storage : NaN) * (UNIT_KB[input.unit] || UNIT_KB.TB);
  const S = '86,400 s';
  const f1 = { key: 'qps', label: 'Peak QPS (reads + writes)', given: isNaN(qps) ? '–' : fmtN(qps) + '/s', expected: fmtN(e.peakQps) + '/s', ...band(qps, e.peakQps),
    how: `Reads ${fmtN(v.dau)} × ${num(v.readsPerUser)} ÷ ${S} ≈ ${fmtN(e.rAvg)}/s; writes ${fmtN(v.dau)} × ${num(v.writesPerUser)} ÷ ${S} ≈ ${fmtN(e.wAvg)}/s. Peak = (${fmtN(e.rAvg)} + ${fmtN(e.wAvg)}) × ${v.peak} ≈ **${fmtN(e.peakQps)}/s**. Rounding a day to 10⁵ s is fine.` };
  const f2 = { key: 'ratio', label: 'Read : write ratio', given: isNaN(ratio) ? '–' : ratioText(ratio), expected: ratioText(e.ratio), ...band(ratio, e.ratio),
    how: `${num(v.readsPerUser)} reads ÷ ${num(v.writesPerUser)} writes per user = **${ratioText(e.ratio)}**. ${e.ratio >= 10 ? 'Read-heavy: caches and replicas pay off.' : e.ratio < 1 ? 'Write-heavy: think queues, write-optimized stores, batching.' : 'Balanced: both paths need scaling.'}` };
  // Raw and replicated storage are both reasonable readings of "storage per year".
  const raw = band(storeKB, e.yearKB), rep = band(storeKB, e.yearKB * v.replication);
  const best = rep.factor < raw.factor ? rep : raw;
  const media = v.mediaPerUser ? ` + ${num(v.mediaPerUser)} × ${fmtB(v.mediaKB)}` : '';
  const f3 = { key: 'storage', label: 'New storage per year', given: isNaN(storeKB) ? '–' : fmtB(storeKB), expected: `${fmtB(e.yearKB)} (×${v.replication} ≈ ${fmtB(e.yearKB * v.replication)})`, ...best,
    how: `${fmtN(v.dau)} × (${num(v.writesPerUser)} × ${fmtB(v.recordKB)}${media}) ≈ ${fmtB(e.perDayKB)}/day × 365 ≈ **${fmtB(e.yearKB)}/year**, or ${fmtB(e.yearKB * v.replication)} with ${v.replication}× replication. Either reading is accepted.` };
  const fields = [f1, f2, f3];
  return { fields, score: fields.filter(f => f.pass).length / fields.length };
}

export function overallScore(iv) {
  const d = iv.result ? iv.result.goalsPassed / Math.max(1, iv.result.goalsTotal) : 0;
  return Math.round(100 * (WEIGHTS.req * (iv.reqResult?.score || 0) + WEIGHTS.est * (iv.estResult?.score || 0) + WEIGHTS.design * d));
}

// ---------------------------------------------------------------- views
const STEPS = [['req', 'Requirements'], ['est', 'Estimates'], ['design', 'Design'], ['report', 'Report']];
const pctS = x => Math.round(x * 100) + '%';

function header(iv, L) {
  const at = STEPS.findIndex(s => s[0] === iv.step);
  const rem = remainingSec(iv);
  return `<div class="iv-head">
    <div class="lesson-meta"><span class="pill">Interview practice</span><span class="pill">45 min</span></div>
    <h1>${esc(L.title)}</h1>
    <div class="iv-steps">${STEPS.map(([k, l], i) => `<span class="iv-step ${i < at ? 'done' : i === at ? 'cur' : ''}"><i>${i < at ? '✓' : i + 1}</i>${l}</span>`).join('')}</div>
    <div class="iv-clock ${rem < 0 ? 'over' : rem < 300 ? 'low' : ''}" data-iv-clock><span data-iv-label>${clockLabel(iv, rem)}</span><b data-iv-timer>${iv.submittedAt ? clockText(ROUND_SEC - rem) : clockText(rem)}</b></div>
  </div>`;
}

export function pickerHTML(attempts) {
  const best = {};
  for (const a of attempts) if (!best[a.id] || a.overall > best[a.id].overall) best[a.id] = a;
  const recent = attempts.slice(-8).reverse();
  return `<article class="lesson iv">
    <div class="lesson-meta"><span class="pill">Interview practice</span></div>
    <h1>Mock system design round</h1>
    <p class="lede">45 minutes, one prompt, the same loop a real interviewer runs: clarify requirements, estimate scale, design, then defend it under load.</p>
    <div class="md">${md(`1. **Requirements**: tick what you'd ask about. Some options are traps.
2. **Estimates**: peak QPS, read:write ratio and storage per year. Within 10× of the reference passes.
3. **Design**: a blank canvas with just the users. Build, test with ▶ Run, then **Submit**.
4. **Report**: your design faces the case study's scenario (traffic, failures, goals), scored against the reference solution.`)}</div>
    <h2>Pick a prompt</h2>
    <div class="templates">${IV_IDS.map(id => { const L = findLesson(id); const b = best[id]; return `<a class="tpl iv-prompt" href="#/interview/${id}"><b>${esc(L.title)}</b><span>${esc(L.summary)}</span>${b ? `<em class="iv-best">Best: ${b.overall}/100</em>` : ''}</a>`; }).join('')}</div>
    ${recent.length ? `<h2>Recent attempts</h2><table class="kv iv-hist">${recent.map(a => `<tr><td>${esc(findLesson(a.id)?.title || a.id)}<small> · ${new Date(a.at).toLocaleDateString()}</small></td><td><b>${a.overall}</b>/100 · ${a.goalsPassed}/${a.goalsTotal} goals · ${clockText(a.timeUsed)}</td></tr>`).join('')}</table>` : ''}
  </article>`;
}

export function stepHTML(iv, ctx) {
  const L = findLesson(iv.id);
  const body = { req: reqHTML, est: estHTML, design: designHTML, report: reportHTML }[iv.step](iv, L, ctx);
  return `<article class="lesson iv">${header(iv, L)}${body}
    <div class="iv-foot"><button class="btn ghost small" data-iv="restart">↺ Start this prompt over</button><a href="#/interview">All prompts</a></div></article>`;
}

function reqHTML(iv, L) {
  const items = REQS[iv.id];
  const order = shuffled(items.length, iv.seed);
  const r = iv.reqResult;
  const picks = new Set(iv.picks);
  const group = g => order.filter(i => items[i][0] === g).map(i => {
    const [, rel, text, why] = items[i];
    const cls = !r ? '' : rel ? (picks.has(i) ? 'right' : 'missed') : (picks.has(i) ? 'wrong' : 'skip');
    return `<label class="iv-req ${cls}"><input type="checkbox" data-req="${i}" ${picks.has(i) ? 'checked' : ''} ${r ? 'disabled' : ''}><span>${esc(text)}${r && cls !== 'skip' ? `<small>${cls === 'missed' ? '<b>Missed.</b> ' : cls === 'wrong' ? '<b>Trap.</b> ' : ''}${esc(why)}</small>` : ''}</span></label>`;
  }).join('');
  return `<p class="lede">“${esc(L.title)}.” The interviewer waits. Which requirements would you clarify before designing? Tick everything you’d ask about or commit to; leave out what you’d push back on.</p>
    <h3>Functional</h3>${group('F')}
    <h3>Non-functional</h3>${group('N')}
    ${r ? `<div class="iv-score"><b>${r.hits}/${r.total}</b> key requirements covered${r.wrong.length ? `, <b>${r.wrong.length}</b> trap${r.wrong.length > 1 ? 's' : ''} picked` : ''} → <b>${pctS(r.score)}</b></div>
      <div class="iv-actions"><button class="btn primary" data-iv="to-est">Continue to estimates →</button></div>`
    : `<div class="iv-actions"><button class="btn primary" data-iv="lock-req">Lock in requirements</button><span class="muted small">Aim for about 5 minutes.</span></div>`}`;
}

function estHTML(iv, L) {
  const r = iv.estResult;
  const e = iv.est || {};
  const dis = r ? 'disabled' : '';
  return `<p class="lede">Back-of-the-envelope time. The interviewer gives you these numbers:</p>
    <div class="md"><ul>${scaleFacts(L).map(f => `<li>${md(f).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></div>
    <div class="iv-est">
      <label><span>Peak QPS (reads + writes)</span><input data-est="qps" placeholder="e.g. 35k" value="${esc(e.qps || '')}" ${dis}></label>
      <label><span>Read : write ratio</span><div class="iv-ratio"><input data-est="r" type="number" min="0" step="any" placeholder="reads" value="${esc(e.r || '')}" ${dis}><b>:</b><input data-est="w" type="number" min="0" step="any" placeholder="writes" value="${esc(e.w || '')}" ${dis}></div></label>
      <label><span>New storage per year</span><div class="iv-ratio"><input data-est="storage" type="number" min="0" step="any" placeholder="amount" value="${esc(e.storage || '')}" ${dis}><select data-est="unit" ${dis}>${['GB', 'TB', 'PB'].map(u => `<option ${(e.unit || 'TB') === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div></label>
    </div>
    ${r ? `${estTable(r)}<div class="iv-score"><b>${r.fields.filter(f => f.pass).length}/3</b> within an order of magnitude → <b>${pctS(r.score)}</b></div>
      <div class="iv-actions"><button class="btn primary" data-iv="to-design">Continue to the design →</button></div>`
    : `<div class="iv-actions"><button class="btn primary" data-iv="check-est">Check my estimates</button><span class="muted small">Round hard: 1 day ≈ 10⁵ s.</span></div>`}`;
}

function estTable(r) {
  const tag = { close: ['ok', 'spot on'], ok: ['ok', 'accepted'], off: ['bad', 'off'] };
  return r.fields.map(f => `<div class="iv-est-row ${tag[f.grade][0]}">
    <div class="iv-est-top"><b>${esc(f.label)}</b><span class="iv-tag">${tag[f.grade][1]}${isFinite(f.factor) && f.factor > 1.05 ? ` · ${times(f.factor)} away` : ''}</span></div>
    <div class="iv-est-vals"><span>You: <b>${esc(f.given)}</b></span><span>Reference: <b>${esc(f.expected)}</b></span></div>
    <div class="iv-how">${md(f.how).replace(/^<p>|<\/p>$/g, '')}</div></div>`).join('');
}

function designHTML(iv, L, ctx) {
  const lab = L.lab;
  const u = lab.graph.nodes.find(n => n.type === 'client');
  const ev = (lab.events || []).filter(e => e.do !== 'say');
  const given = lab.graph.nodes.filter(n => n.type === 'external');
  return `<p class="lede">Build the architecture on the canvas. Drag components from the palette and connect them from the ● on each node’s right edge.</p>
    <h3>The scenario your design will face</h3>
    <table class="kv"><tr><td>Traffic</td><td>${(u.params.rps || 0).toLocaleString('en-US')} rps · ${Math.round((u.params.readRatio ?? 0.9) * 100)}% reads</td></tr>
      ${u.params.staticRatio ? `<tr><td>Static/media share</td><td>${Math.round(u.params.staticRatio * 100)}% of requests · ${u.params.staticKB} KB each</td></tr>` : ''}
      ${u.params.rttMs ? `<tr><td>Users’ network distance</td><td>~${u.params.rttMs} ms</td></tr>` : ''}
      <tr><td>Run length</td><td>${lab.duration || 60}s simulated</td></tr></table>
    ${ev.length ? `<div class="timeline">${ev.map(e => `<div class="ev"><span class="at">${e.at}s</span>${esc(ctx.describeEvent(e))}</div>`).join('')}</div>` : ''}
    ${given.length ? `<p class="muted small">Already on the canvas: ${given.map(n => `<b>${esc(n.label || 'external service')}</b>`).join(', ')}. Third-party providers are given; wire them in.</p>` : ''}
    <h3>Goals (the interviewer’s SLOs)</h3>
    ${lab.goals.map(g => `<div class="goal wait"><span class="gi">○</span><span class="gl">${esc(g.label || g.metric)}<small>${g.at === 'end' ? 'checked at the end' : 'must hold for the whole run'}</small></span></div>`).join('')}
    <p class="muted small">▶ Run tests your design at steady traffic with no scenario events. <b>Submit</b> plays the full scenario once and scores it.</p>
    <div class="iv-actions"><button class="btn primary" data-iv="submit">Submit design</button><button class="btn ghost" data-iv="back-est">← Estimates</button></div>`;
}

function reportHTML(iv, L, ctx) {
  const r = iv.result;
  const { METRICS, usd } = ctx;
  const f = (m, v) => (METRICS[m]?.fmt || String)(v);
  const overall = overallScore(iv);
  const costDelta = r.refCost > 0 ? r.cost / r.refCost : 1;
  return `<div class="iv-total ${r.pass ? 'pass' : 'fail'}"><span>Overall</span><b>${overall}<small>/100</small></b><em>${r.pass ? 'Design held up under the scenario' : 'Design broke under the scenario'}</em></div>
    <table class="kv">
      <tr><td>Requirements (25%)</td><td>${iv.reqResult.hits}/${iv.reqResult.total}${iv.reqResult.wrong.length ? ` − ${iv.reqResult.wrong.length} trap${iv.reqResult.wrong.length > 1 ? 's' : ''}` : ''} · <b>${pctS(iv.reqResult.score)}</b></td></tr>
      <tr><td>Estimates (25%)</td><td>${iv.estResult.fields.filter(x => x.pass).length}/3 · <b>${pctS(iv.estResult.score)}</b></td></tr>
      <tr><td>Design goals (50%)</td><td>${r.goalsPassed}/${r.goalsTotal} · <b>${pctS(r.goalsPassed / Math.max(1, r.goalsTotal))}</b></td></tr>
      <tr><td>Cost / month</td><td>${usd(r.cost)} vs reference ${usd(r.refCost)} <small>(${costDelta <= 1 ? 'cheaper or equal' : times(costDelta) + ' the reference'})</small></td></tr>
      <tr><td>Time used</td><td>${clockText(r.timeUsed)} of 45:00</td></tr>
    </table>
    <h3>Design goals</h3>
    ${r.goals.map(g => `<div class="goal ${g.failed ? 'fail' : 'pass'}"><span class="gi">${g.failed ? '✗' : '✓'}</span><span class="gl">${esc(g.label || METRICS[g.metric]?.label || g.metric)}<small>${g.failed ? (g.at === 'end' ? 'missed at the end' : `broke at ${g.at_}s`) : 'held'}</small></span><span class="gv">${g.v != null ? f(g.metric, g.v) : '–'}<small>${g.op} ${f(g.metric, g.value)}</small></span></div>`).join('')}
    <div class="iv-actions">
      <button class="btn primary" data-iv="replay">▶ Watch the scenario on my design</button>
      <button class="btn ghost" data-iv="side">Show reference side by side</button>
      <button class="btn ghost" data-iv="swap">Swap in the reference</button>
    </div>
    <p class="muted small">Both comparison actions can be undone with ↶ (Ctrl+Z).</p>
    ${L.lab.debrief ? `<h3>What the reference does</h3><div class="debrief">${md(L.lab.debrief)}</div>` : ''}
    <h3>Your requirements and estimates</h3>
    ${iv.reqResult.missed.length ? `<p><b>Missed:</b></p><ul class="iv-list">${iv.reqResult.missed.map(i => `<li>${esc(REQS[iv.id][i][2])} <span class="muted">${esc(REQS[iv.id][i][3])}</span></li>`).join('')}</ul>` : '<p>No key requirement missed.</p>'}
    ${iv.reqResult.wrong.length ? `<p><b>Traps picked:</b></p><ul class="iv-list">${iv.reqResult.wrong.map(i => `<li>${esc(REQS[iv.id][i][2])} <span class="muted">${esc(REQS[iv.id][i][3])}</span></li>`).join('')}</ul>` : ''}
    ${estTable(iv.estResult)}
    <div class="iv-actions"><button class="btn primary" data-iv="again">Try again</button><a class="btn ghost" href="#/${iv.id}">Read the lesson</a></div>`;
}
