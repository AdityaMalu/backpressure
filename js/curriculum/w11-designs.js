import { G, X, Y } from './util.js';

const FRAME = `
> **Key idea** Every design below follows the same interview loop: **requirements → estimates → API → data model → high-level design → deep dives → bottlenecks & trade-offs**. Practice saying each step out loud in under 45 minutes.
`;

export default {
  week: '11–12',
  title: 'Design Real-World Systems',
  lessons: [
    // ------------------------------------------------------------------
    {
      id: 'url-shortener',
      title: 'Design a URL shortener',
      minutes: 35,
      summary: 'The classic warm-up: tiny writes, enormous reads, and a surprising amount of depth in ID generation, caching and analytics.',
      calculator: { dau: 100000000, readsPerUser: 10, writesPerUser: 0.1, recordKB: 0.5, peak: 3, years: 5, replication: 3, serverRps: 2000 },
      body: `${FRAME}
## 1. Requirements

**Functional**
- Shorten a long URL → \`https://sho.rt/aZ3kQ9x\`; optional custom alias and expiry.
- Redirect short → long, fast.
- (Often) click analytics per link.

**Non-functional**
- Very read-heavy (~100:1). Redirect latency p99 < ~50 ms server-side.
- High availability for redirects (a dead link is a broken product).
- Short codes must be unique and not guessable in sequence (optional).

## 2. Estimates
- 100M DAU, 10 redirects/day each → **~12k redirects/s** average, ~35k peak.
- 1% of users create a link daily → **~120 writes/s**.
- 5 years × 365 × 10M links ≈ **18B links** × ~500 B ≈ 9 TB (×3 replicas ≈ 27 TB).
- 7-char base62 codes: 62⁷ ≈ **3.5 trillion**, plenty.

## 3. API
\`\`\`
POST /v1/links        {longUrl, customAlias?, expiresAt?}  → 201 {code, shortUrl}
GET  /{code}          → 301/302 Location: longUrl
GET  /v1/links/{code}/stats → clicks by day, referrer, country
\`\`\`
**301 vs 302**: 301 (permanent) is cached by browsers and CDNs, so far less load, but you lose per-click analytics. 302 (temporary), or 301 with short \`Cache-Control\`, keeps clicks visible. A common answer: 302 + edge caching with a short TTL, or 301 when analytics aren't needed.

## 4. Data model
\`links(code PK, long_url, user_id, created_at, expires_at)\`: a pure key-value access pattern. Either a KV/NoSQL store (DynamoDB, Cassandra) or a sharded SQL table keyed by code. Analytics go to a separate pipeline (click events → Kafka → OLAP store like ClickHouse), never as synchronous counter updates on the hot path.

## 5. Generating codes
- **Hash the URL** (MD5/SHA → base62, take 7 chars): same URL → same code (dedupe), but collisions need handling (check-and-retry with salt).
- **Counter + base62**: a unique 64-bit ID encoded in base62. Use a distributed ID source: ranges pre-allocated to each server ("ticket server" hands out blocks of 1,000), or Snowflake IDs (timestamp + machine + sequence). Sequential codes are guessable; shuffle bits or encrypt the ID if that matters.
- **Pre-generated key pool**: a Key Generation Service fills a table of unused random codes; app servers grab batches.

## 6. High-level design
\`Client → CDN/edge → LB → stateless redirect service → cache (Redis) → links DB\`, with writes going to the DB and click events published asynchronously.

- The hot set is small (a few % of links get most clicks), so cache hit ratios of 95–99% are realistic.
- Cache at the **edge** too: redirects for popular links can be answered by the CDN without touching your origin.

## 7. Bottlenecks & trade-offs
- **Hot links** (a viral tweet): edge cache + Redis; the DB never sees them.
- **Analytics** must not slow redirects: fire-and-forget event to a queue.
- **Abuse**: rate limit link creation, scan for malware/phishing.
- **Expiry**: lazy deletion on read plus a background sweeper.

> **Interview** Spend little time on the obvious and go deep on two things: code generation (uniqueness at scale) and the read path (cache + edge, 301 vs 302 trade-off).

## The lab
**20,000 redirects/s** (99% reads) from users ~80 ms away. The starter is a modest app tier on a single SQL database. Build the read path: cache, and edge-cache redirects at the CDN, for under **$2,500/month**.
`,
      quiz: [
        { q: 'Why might a URL shortener return 302 instead of 301?', options: ['302 is faster', '301s are cached by browsers, so later clicks never reach your servers and you lose analytics', '301 is deprecated', '302 uses less bandwidth'], answer: 1, why: 'Permanent redirects get cached aggressively. If you need click counts, use 302 or short cache lifetimes.' },
        { q: 'Best way to generate unique short codes across 50 app servers?', options: ['Each server picks random 3-char codes', 'Pre-allocated ID ranges (or Snowflake IDs) encoded in base62', 'Use the long URL’s length', 'A single global auto-increment row locked on every request'], answer: 1, why: 'Ranges/Snowflake give uniqueness without per-request coordination; a single locked counter becomes a bottleneck.' },
      ],
      lab: {
        title: 'Build the redirect path',
        brief: `**20,000 rps**, 99% redirects (reads), users ~80 ms away. The hot set of links is ~10 GB.

Design the read path. Ideas: a **cache** in front of the DB, and a **CDN** that caches redirects at the edge (turn on *Cache API GETs*).

Goals: p99 under **250 ms**, errors under **0.5%**, cost under **$2,500/month**.`,
        duration: 45,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 20000, readRatio: 0.99, workingSetGB: 10, rttMs: 80 }],
          ['lb', 'lb', X(1.5), Y(1), { instances: 1 }],
          ['app', 'app', X(2.5), Y(1), { instances: 12, baseMs: 5 }, 'Redirect svc'],
          ['db', 'sqldb', X(3.5), Y(1), { size: 'M' }, 'Links DB'],
        ], ['u>lb', 'lb>app', 'app>db']),
        goals: [
          { metric: 'p99', op: '<', value: 250, label: 'p99 under 250 ms', after: 6 },
          { metric: 'errRate', op: '<', value: 0.005, label: 'Errors under 0.5%', after: 6 },
          { metric: 'cost', op: '<', value: 2500, label: 'Cost under $2,500/month', after: 0 },
        ],
        hints: [
          'The DB sees 19,800 reads/s, far beyond an M primary. Add a **Cache** (App → Cache → DB) with enough memory for the 10 GB hot set.',
          'The app tier needs ~20k rps of capacity (~60 S instances): too expensive. Put a **CDN** in front (Users → CDN → LB) with **Cache API GETs** on and a high API hit ratio: popular redirects never reach your origin.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 20000, readRatio: 0.99, workingSetGB: 10, rttMs: 80 }],
          ['cdn', 'cdn', X(1), Y(1), { cacheApi: true, apiHit: 0.85 }],
          ['lb', 'lb', X(2), Y(1), { instances: 1 }],
          ['app', 'app', X(3), Y(1), { instances: 12, baseMs: 5 }, 'Redirect svc'],
          ['cache', 'cache', X(4), Y(0.3), { memoryGB: 16 }],
          ['db', 'sqldb', X(4), Y(1.7), { size: 'M' }, 'Links DB'],
        ], ['u>cdn', 'cdn>lb', 'lb>app', 'app>cache', 'cache>db', 'app>db']),
        debrief: 'Layered caching did the work: the CDN answered most redirects at the edge, Redis absorbed most of the rest, and the database only saw writes and cold links. In the interview, the analytics trade-off (edge-cached redirects aren’t counted unless the edge logs them) is the follow-up to expect.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'whatsapp',
      title: 'Design WhatsApp (chat)',
      minutes: 40,
      summary: 'Real-time delivery to billions of devices over persistent connections, with ordering, offline delivery, receipts and group fan-out.',
      calculator: { dau: 2000000000, readsPerUser: 40, writesPerUser: 40, recordKB: 0.2, peak: 2, years: 1, replication: 3, serverRps: 5000 },
      body: `${FRAME}
## 1. Requirements

**Functional**
- 1:1 and group chat (groups up to ~1,000), text + media.
- Delivery & read receipts (✓ sent, ✓✓ delivered, blue ✓✓ read).
- Online/last-seen presence.
- Offline users receive messages when they reconnect; push notification meanwhile.
- History sync across a user's devices.

**Non-functional**
- Low latency delivery (< 200 ms when both online), **no message loss**, per-conversation **ordering**.
- Massive scale: ~100B messages/day.
- End-to-end encryption (server stores ciphertext only).

## 2. Estimates
- 100B messages/day → **~1.2M messages/s** average, peak ~2–3M.
- ~200 B per message (text) → 20 TB/day of messages (media separately in blob storage + CDN).
- Hundreds of millions of **concurrent connections**. At ~100k–1M connections per gateway box (Erlang/epoll), that's thousands of gateway servers.

## 3. Connection layer
Clients hold a persistent connection (**WebSocket** or a custom TCP protocol, as WhatsApp's XMPP derivative) to a **chat gateway**. Gateways are stateful in one sense: they hold sockets. A **session registry** (in-memory store) maps \`user_id → gateway_id\` so other services know where to deliver.

Why not HTTP polling? Polling wastes battery and adds latency; long-polling is a fallback. Server push over one persistent connection is the norm.

## 4. Message flow (1:1)
1. Sender's gateway receives \`send(convId, clientMsgId, ciphertext)\`.
2. **Persist first**: write to the message store (and/or append to a Kafka partition keyed by \`conversation_id\`, for ordering), assign a server sequence number, ack the sender (✓).
3. Look up the recipient's gateway in the session registry. If online → push over their socket; on device ack → mark delivered (✓✓) and notify sender.
4. If offline → keep in the recipient's **inbox** (undelivered queue) and send a **push notification** via APNs/FCM. On reconnect, the client syncs everything after its last acked sequence.

\`clientMsgId\` makes sends idempotent: a retry after a flaky network doesn't duplicate the message.

## 5. Data model
- **Messages**: wide-column store (Cassandra/HBase) partitioned by \`conversation_id\`, clustered by \`seq\` desc → "latest 50 messages in this chat" is one partition read. Massive write throughput, horizontal scale.
- **Inbox/undelivered**: per-user queue (key-value or Kafka).
- **Conversations & membership**: SQL or KV.
- **Media**: upload to object storage directly (pre-signed URL), send only the media ID/key in the message; recipients download via CDN.

## 6. Groups
Fan-out on write: a message to a 500-member group is written once and **delivered** 500 times (one per member's gateway/inbox). Large groups use a dedicated fan-out service and queue; very large broadcast channels may switch to fan-out on read.

## 7. Presence
Heartbeats over the connection update \`last_seen\` in an in-memory store with TTL; changes are published only to users who have the chat open (subscriptions), never broadcast to all contacts.

## 8. Bottlenecks & trade-offs
- **Ordering** is per conversation: key Kafka/partitions by conversation_id; clients order by server seq.
- **Gateway failure** drops thousands of sockets: clients reconnect (with jittered backoff!) to another gateway and resync from their last seq.
- **Hot groups / celebrities**: rate limit, dedicated partitions.
- **Push provider quotas and latency**: async workers, batching, retries.
- **E2E encryption** means the server can't search or moderate content; sender keys make group encryption efficient.

> **Interview** Draw the gateway + session registry, walk one message from send to ✓✓, then the offline path. Say "persist before ack" and "partition by conversation for ordering."

## The lab
**30,000 rps** at the chat gateways: 70% are sends (writes), 30% history syncs (reads). Messages must be durably stored and delivered (with a push notification) via async workers. The starter writes straight into one SQL database.
`,
      quiz: [
        { q: 'How does the system know which server holds a recipient’s connection?', options: ['Broadcast the message to every gateway', 'A session registry mapping user_id → gateway, updated on connect/disconnect', 'DNS', 'The recipient polls every server'], answer: 1, why: 'A fast lookup (usually an in-memory KV store) routes each message to exactly the right gateway.' },
        { q: 'What guarantees messages in one chat appear in order?', options: ['Client timestamps', 'Partitioning by conversation_id and assigning a per-conversation sequence number', 'A global lock', 'Sorting by message length'], answer: 1, why: 'A single partition per conversation gives a total order there; client clocks are unreliable.' },
      ],
      lab: {
        title: 'Deliver 21k messages a second',
        brief: `**30,000 rps** at the chat gateways: **70% sends**, 30% history reads.

Build the async delivery path: **Chat gateway → Queue (Kafka) → Delivery workers → Messages store (NoSQL)**, with workers also calling the **Push provider** (APNs/FCM). Reads (history sync) go straight to the messages store.

Goals: p99 under **300 ms**, errors under **0.5%**, consumer lag under **10 s**, cost under **$16,000/month**.`,
        duration: 50,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 30000, readRatio: 0.3, rttMs: 60 }, 'Phones'],
          ['lb', 'lb', X(1), Y(1.5), { instances: 2 }],
          ['gw', 'app', X(2), Y(1.5), { instances: 70, size: 'S', baseMs: 5 }, 'Chat gateway'],
          ['db', 'sqldb', X(3), Y(1.5), { size: 'XL' }, 'Messages DB'],
          ['push', 'external', X(4), Y(0.3), { latencyMs: 150, quotaRps: 60000, errorRate: 0.002 }, 'Push (APNs/FCM)'],
        ], ['u>lb', 'lb>gw', 'gw>db']),
        goals: [
          { metric: 'p99', op: '<', value: 300, label: 'p99 under 300 ms', after: 8 },
          { metric: 'errRate', op: '<', value: 0.005, label: 'Errors under 0.5%', after: 8 },
          { metric: 'consumerLag', op: '<', value: 10, label: 'Consumer lag under 10 s', after: 8 },
          { metric: 'cost', op: '<', value: 16000, label: 'Cost under $16k/month', after: 0 },
        ],
        hints: [
          'Replace the SQL DB with **NoSQL (Cassandra)**. Work ≈ 9k reads × 2 (QUORUM) + 21k writes × 3 (RF) ≈ 81k units → ~25 nodes at 65%.',
          'Add a **Queue** (Chat gateway → Queue) and **Workers** (Queue → Workers → NoSQL, Workers → Push). Writes go to the queue automatically; keep Chat gateway → NoSQL for history reads.',
          'Each S worker does ~500 msgs/s, so ~50 workers. Partitions must be ≥ the number of workers. Also: 3 LB instances for 30k rps.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 30000, readRatio: 0.3, rttMs: 60 }, 'Phones'],
          ['lb', 'lb', X(1), Y(1.5), { instances: 3 }],
          ['gw', 'app', X(2), Y(1.5), { instances: 70, size: 'S', baseMs: 5 }, 'Chat gateway'],
          ['q', 'queue', X(3), Y(0.5), { partitions: 64 }, 'messages topic'],
          ['wk', 'worker', X(4), Y(0.5), { instances: 56, size: 'S' }, 'Delivery workers'],
          ['db', 'nosql', X(5), Y(1.5), { nodes: 26, rf: 3, consistency: 'QUORUM' }, 'Messages (Cassandra)'],
          ['push', 'external', X(5), Y(0), { latencyMs: 150, quotaRps: 60000, errorRate: 0.002 }, 'Push (APNs/FCM)'],
        ], ['u>lb', 'lb>gw', 'gw>q', 'q>wk', 'wk>db', 'wk>push', 'gw>db']),
        debrief: 'The gateway only appends to a durable log and acks (✓), so senders see low latency while delivery, storage and push happen asynchronously, each scaled independently. Cassandra’s write scaling makes 21k messages/s routine. At WhatsApp scale, multiply everything by ~50, and the shape stays the same.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'instagram',
      title: 'Design Instagram (feed & media)',
      minutes: 40,
      summary: 'Photo uploads, a personalized home feed, and the celebrity problem. A masterclass in read-optimized design: fan-out, caching and CDNs.',
      calculator: { dau: 500000000, readsPerUser: 50, writesPerUser: 0.2, recordKB: 1, mediaPerUser: 0.2, mediaKB: 2000, peak: 3, years: 5, replication: 3, serverRps: 1000 },
      body: `${FRAME}
## 1. Requirements

**Functional**: upload photos/videos with captions; follow users; home feed of followed accounts' posts (ranked); likes/comments; profile pages.

**Non-functional**: feed loads fast (< 200–300 ms server time), media loads fast worldwide, high availability; eventual consistency is fine (a post may take seconds to appear in feeds); extremely read-heavy.

## 2. Estimates
- 500M DAU × 50 feed/media reads → **~300k reads/s** (most are image fetches served by CDN).
- 100M uploads/day → ~1.2k uploads/s; at ~2 MB (multiple resolutions), **~200 TB/day** of new media → object storage, many PB/year.
- Feed requests (API) ~50k/s; media requests ~250k/s → **CDN** is mandatory.

## 3. API
\`\`\`
POST /v1/media/upload-url            → pre-signed URL (client uploads directly to object storage)
POST /v1/posts {mediaKeys, caption}  → 201
GET  /v1/feed?cursor=…               → [{post, author, mediaUrls(CDN), likeCount}]
POST /v1/posts/{id}/like
\`\`\`

## 4. Data model
- **Posts**: \`post_id (Snowflake: time-sortable), author_id, caption, media_keys, created_at\`, sharded by post_id or author_id.
- **Follows**: \`(follower_id, followee_id)\` both directions indexed: "who do I follow" and "who follows me".
- **Feed (timeline) cache**: per user, a list of recent post IDs (Redis sorted set / list), capped at a few hundred.
- **Media**: object storage, with keys in post metadata; served via CDN with resized variants.

## 5. The feed: fan-out on write vs. read

**Fan-out on write (push)**: when Alice posts, a worker pushes the post ID into every follower's timeline cache. Reading a feed is then one cache read. ✅ Fast reads. ❌ A celebrity with 300M followers creates 300M writes per post ("write amplification"), and inactive users' timelines get filled pointlessly.

**Fan-out on read (pull)**: build the feed at read time by fetching recent posts from everyone you follow and merging. ✅ Cheap writes. ❌ Slow, expensive reads (follow 1,000 people → 1,000 lookups).

**Hybrid** (what Instagram/Twitter do): push for normal users; for celebrities (above a follower threshold), **don't fan out**: at read time, merge the precomputed timeline with recent posts from the few celebrities you follow. Ranking (ML) is then applied to the candidate set.

## 6. Upload path
Client → get pre-signed URL → upload straight to object storage (your servers never proxy bytes) → \`POST /posts\` → enqueue processing (thumbnails, resizes, transcodes, moderation) → fan-out workers update timelines asynchronously.

## 7. Hot keys
A celebrity's post gets millions of reads and likes in minutes. Their profile and post rows become hot partitions in the database. Defenses: aggressive caching of hot objects (with request coalescing), **sharded counters** for likes (N sub-counters summed on read, or async aggregation), CDN for media.

## 8. Bottlenecks & trade-offs
- Feed freshness vs. cost (fan-out lag is acceptable: seconds).
- Storage cost of media (tiering: hot → infrequent-access → archive).
- Ranking latency budget: precompute candidates, rank a few hundred in < 50 ms.

> **Interview** The fan-out discussion is the heart of this question. Explain both, state the celebrity problem, and propose the hybrid with a follower-count threshold.

## The lab
**50,000 rps**: most are image fetches; the rest are feed reads and a trickle of posts. A celebrity effect means **30% of feed reads hit the same few keys**. The starter serves images from app servers and reads feeds straight from Cassandra.
`,
      quiz: [
        { q: 'Why not fan out on write for an account with 300M followers?', options: ['Followers would see the post too early', 'One post becomes 300M timeline writes: huge write amplification and lag for everyone', 'Celebrities post less', 'Redis cannot store that many lists'], answer: 1, why: 'Push works when follower counts are modest. For mega-accounts, pull their posts at read time and merge (hybrid).' },
        { q: 'How should a client upload a 50 MB video?', options: ['POST the bytes to the API server, which forwards them to storage', 'Get a pre-signed URL and upload directly to object storage', 'Send it base64 inside JSON', 'Email it'], answer: 1, why: 'Direct-to-storage uploads keep app servers free of bulk bytes and scale with the storage service.' },
      ],
      lab: {
        title: 'Feeds, images and a celebrity',
        brief: `**50,000 rps**: ~80% image fetches (100 KB), the rest feed reads plus a few posts. Users are worldwide (~120 ms away). **30% of feed reads** hit a celebrity's hot keys.

Build the read path: **CDN + object storage** for images, a **timeline cache** in front of the posts store, and an **async fan-out** path for new posts (queue + workers).

Goals: p99 under **400 ms**, errors under **1%**, cost under **$400,000/month** (media egress dominates).`,
        duration: 50,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 50000, readRatio: 0.99, staticRatio: 0.81, staticKB: 100, rttMs: 120, workingSetGB: 30 }],
          ['lb', 'lb', X(1.5), Y(1.5), { instances: 3 }],
          ['app', 'app', X(2.5), Y(1.5), { instances: 60, size: 'L' }, 'Feed API'],
          ['db', 'nosql', X(3.5), Y(1.5), { nodes: 12, rf: 3, consistency: 'QUORUM', hotKeySkew: 0.3 }, 'Posts (Cassandra)'],
        ], ['u>lb', 'lb>app', 'app>db']),
        goals: [
          { metric: 'p99', op: '<', value: 400, label: 'p99 under 400 ms', after: 8 },
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 8 },
          { metric: 'cost', op: '<', value: 400000, label: 'Cost under $400k/month', after: 3 },
        ],
        hints: [
          'Images: Users → **CDN** → LB, plus CDN → **Object Storage**. Image bytes from your own servers are ~3× pricier and burn app CPU.',
          'Hot keys melt one Cassandra partition. Put a **Cache (Redis)** in front (Feed API → Cache → Posts): the celebrity’s posts are served from memory. Turn on coalescing.',
          'New posts: Feed API → **Queue** → **Workers** (fan-out) → Posts store. Then shrink the app tier: without image traffic it needs far fewer instances.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 50000, readRatio: 0.99, staticRatio: 0.81, staticKB: 100, rttMs: 120, workingSetGB: 30 }],
          ['cdn', 'cdn', X(1), Y(1.5), { staticHit: 0.97 }],
          ['blob', 'blob', X(2), Y(0.2), {}, 'Media (S3)'],
          ['lb', 'lb', X(2), Y(1.5), { instances: 1 }],
          ['app', 'app', X(3), Y(1.5), { instances: 14, size: 'M' }, 'Feed API'],
          ['cache', 'cache', X(4), Y(0.6), { memoryGB: 64, nodes: 1, coalescing: true }, 'Timeline cache'],
          ['q', 'queue', X(4), Y(2.6), { partitions: 6 }, 'post-events'],
          ['wk', 'worker', X(5), Y(2.6), { instances: 2 }, 'Fan-out workers'],
          ['db', 'nosql', X(5), Y(1.3), { nodes: 6, rf: 3, consistency: 'QUORUM', hotKeySkew: 0.3 }, 'Posts (Cassandra)'],
        ], ['u>cdn', 'cdn>blob', 'cdn>lb', 'lb>app', 'app>cache', 'cache>db', 'app>q', 'q>wk', 'wk>db']),
        debrief: 'Three classic moves: media to the edge (CDN + object storage), hot reads to memory (cache in front of a hot-partitioned store), and writes off the request path (queue + fan-out workers). The remaining cost is almost entirely bandwidth, exactly as at real photo-sharing companies.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'youtube',
      title: 'Design YouTube (video streaming)',
      minutes: 40,
      summary: 'Upload, transcode, store and stream video to millions of concurrent viewers. The hard parts are bandwidth, the transcoding pipeline and adaptive streaming.',
      calculator: { dau: 1000000000, readsPerUser: 5, writesPerUser: 0.001, recordKB: 1, mediaPerUser: 0.001, mediaKB: 300000, peak: 2, years: 1, replication: 3, serverRps: 1000 },
      body: `${FRAME}
## 1. Requirements

**Functional**: upload videos; watch with smooth playback on any device/network; search; recommendations; view counts, likes, comments.

**Non-functional**: playback starts fast (< 2 s) and doesn't stall; extremely high availability of playback; uploads can take minutes to process (async is fine); global audience.

## 2. Estimates
- 1B DAU × 5 videos/day = 5B views/day ≈ **58k video starts/s**.
- Each view streams segments (2–10 s chunks): **hundreds of thousands of chunk requests/s**.
- Average bitrate 2–5 Mbps × millions of concurrent viewers → **tens of Tbps** of egress. Only CDNs (and ISP-embedded caches like Google Global Cache / Netflix Open Connect) can serve this.
- 500 hours of video uploaded per minute (real YouTube stat) → transcoded into ~5–10 renditions each.

## 3. Upload & processing pipeline
1. Client gets a resumable upload URL; uploads chunks directly to object storage (resumable, so a flaky connection doesn't restart a 2 GB upload).
2. An \`UploadCompleted\` event goes onto a queue.
3. **Transcoding workers** (a DAG of tasks): split the video into segments, transcode each segment in parallel into multiple resolutions/bitrates/codecs (H.264, VP9, AV1), generate thumbnails, run content checks (copyright Content ID, moderation).
4. Write renditions + **manifest** (HLS \`.m3u8\` / DASH \`.mpd\`) to object storage; mark the video ready.

Transcoding is CPU/GPU-heavy and slow (minutes per video). The queue absorbs bursts; the worker fleet autoscales on **queue depth**.

## 4. Playback
- **Adaptive bitrate streaming (HLS/DASH)**: the player downloads a manifest listing renditions, then fetches small segments, switching quality per segment based on measured bandwidth. No stalls on a weak network, just lower quality.
- Segments are immutable files, perfect for CDN caching. Popular videos are cached at the edge; long-tail videos are fetched from origin storage (with origin shield).
- Metadata API (title, counts, recommendations) is a normal web service with caches.

## 5. Data model
- Video metadata: SQL/NoSQL (\`video_id, owner, title, status, renditions, created_at\`).
- View counts: never a synchronous \`UPDATE … +1\` per view. Stream view events into Kafka → aggregate (stream processing) → periodically update counters.
- Blobs: object storage with lifecycle tiers (hot/cold) and erasure coding.

## 6. Bottlenecks & trade-offs
- **Bandwidth cost** dominates: CDN hit ratio, efficient codecs (AV1 saves ~30% vs H.264), ISP peering/embedded caches.
- **Long tail**: most videos are rarely watched; storing all renditions forever is expensive (transcode rare renditions lazily, on demand).
- **Transcoding backlog** during upload spikes: priority queues (popular creators first), autoscaling, spot instances.
- **Live streaming** is a different beast: low-latency segmenting (LL-HLS), real-time transcoding, chat fan-out.

> **Interview** Split the answer cleanly: (1) upload + async transcoding pipeline, (2) playback via CDN + adaptive bitrate, (3) metadata/counters. Interviewers love "why chunked segments?" and "how do you count views at scale?"

## The lab
**20,000 rps**, of which ~95% are **1 MB video segment** requests, plus metadata reads and upload events. Uploads must be **transcoded** by slow workers (2 s per job). The starter has no CDN and no pipeline.
`,
      quiz: [
        { q: 'Why split videos into small segments with multiple renditions?', options: ['To reduce storage', 'So the player can adapt quality per segment to network conditions, and segments cache well on CDNs', 'Because browsers can’t play long files', 'To make uploads faster'], answer: 1, why: 'Adaptive bitrate streaming switches quality per segment; immutable segments are ideal CDN objects.' },
        { q: 'How should view counts be updated?', options: ['UPDATE videos SET views = views + 1 on each view', 'Publish view events to a stream and aggregate asynchronously in batches', 'Count CDN logs once a year', 'Store each view as a row and COUNT(*) on every page load'], answer: 1, why: 'A hot row updated millions of times per minute is a lock bottleneck. Aggregate events and write periodically.' },
      ],
      lab: {
        title: 'Stream it and transcode it',
        brief: `**20,000 rps** from global viewers (~150 ms away): ~95% are **1 MB video segments**; the rest are metadata reads and **uploads** (~200/s) that must be transcoded (2 s of CPU each).

Build:
- **CDN + Object Storage** for segments,
- an upload pipeline: API → **Queue** → **Transcoding workers** (slow!) → Object Storage.

Goals: p99 under **500 ms**, errors under 1%, transcoding lag under **30 s**, cost under **$1.6M/month** (at this scale, bandwidth costs are brutal).`,
        duration: 60,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 20000, readRatio: 0.99, staticRatio: 0.96, staticKB: 1000, rttMs: 150, workingSetGB: 50 }, 'Viewers'],
          ['lb', 'lb', X(1.5), Y(1.5), { instances: 1 }],
          ['app', 'app', X(2.5), Y(1.5), { instances: 40, size: 'L' }, 'Video API'],
          ['db', 'sqldb', X(3.5), Y(1.5), { size: 'M' }, 'Metadata DB'],
        ], ['u>lb', 'lb>app', 'app>db']),
        goals: [
          { metric: 'p99', op: '<', value: 500, label: 'p99 under 500 ms', after: 8 },
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 8 },
          { metric: 'consumerLag', op: '<', value: 30, label: 'Transcoding lag under 30 s', after: 8 },
          { metric: 'cost', op: '<', value: 1600000, label: 'Cost under $1.6M/month', after: 3 },
        ],
        hints: [
          'Users → **CDN** → LB, and CDN → **Object Storage** for segments. Video segments are immutable, so a 98%+ hit ratio is realistic.',
          'Uploads: Video API → **Queue** → **Worker** (set Processing time to 2,000 ms) → **Object Storage**. With 2 s jobs an S worker manages ~50 jobs/s (100 threads ÷ 2 s), so ~6+ workers, and partitions ≥ workers.',
          'Add a **Cache** for metadata reads, and shrink the app tier once segments no longer pass through it.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 20000, readRatio: 0.99, staticRatio: 0.96, staticKB: 1000, rttMs: 150, workingSetGB: 50 }, 'Viewers'],
          ['cdn', 'cdn', X(1), Y(1.5), { staticHit: 0.98 }],
          ['blob', 'blob', X(2), Y(0.2), {}, 'Segments (S3)'],
          ['lb', 'lb', X(2), Y(1.6), { instances: 1 }],
          ['app', 'app', X(3), Y(1.6), { instances: 4, size: 'S' }, 'Video API'],
          ['cache', 'cache', X(4), Y(0.9), { memoryGB: 64 }],
          ['db', 'sqldb', X(5), Y(1.3), { size: 'M' }, 'Metadata DB'],
          ['q', 'queue', X(4), Y(2.6), { partitions: 12 }, 'uploads'],
          ['wk', 'worker', X(5), Y(2.6), { instances: 8, baseMs: 2000 }, 'Transcoders'],
          ['blob2', 'blob', X(6), Y(2.6), {}, 'Renditions (S3)'],
        ], ['u>cdn', 'cdn>blob', 'cdn>lb', 'lb>app', 'app>cache', 'cache>db', 'app>db', 'app>q', 'q>wk', 'wk>blob2']),
        debrief: 'Video is a bandwidth problem first: the CDN cut cost and latency dramatically and removed nearly all load from your servers. Transcoding is a throughput problem: a queue plus a worker fleet sized (and in practice autoscaled) on queue depth. The metadata API is the easy part.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'uber',
      title: 'Design Uber (ride matching)',
      minutes: 40,
      summary: 'Millions of moving drivers report their location every few seconds; riders need the nearest available one in milliseconds. A geospatial, write-heavy, real-time matching problem.',
      calculator: { dau: 20000000, readsPerUser: 20, writesPerUser: 300, recordKB: 0.1, peak: 3, years: 1, replication: 3, serverRps: 2000 },
      body: `${FRAME}
## 1. Requirements

**Functional**: riders request a ride and see nearby drivers; the system matches rider ↔ driver; live location tracking during the trip; ETA and pricing (surge); trip history and payments.

**Non-functional**: matching in < ~1 s; location updates are **write-heavy** and ephemeral; high availability during peaks (concerts, rain, New Year's Eve); strong consistency where it matters (a driver must not be assigned two rides).

## 2. Estimates
- ~5M active drivers sending a GPS update every **4 s** → **~1.25M location writes/s** globally at peak.
- Rider requests: far fewer, ~tens of thousands/s, but each needs a geo query.
- Location data is tiny (~100 B) and only the **latest** value matters for matching; history goes to cheaper storage for analytics.

## 3. Geospatial indexing
"Find available drivers within 2 km" can't scan millions of rows. Options:
- **Geohash**: encode lat/lng into a string where shared prefixes mean proximity; look up the cell plus its 8 neighbors.
- **Quadtree**: recursively split dense areas; adapts to city density.
- **Google S2 / Uber H3**: hierarchical cells on a sphere (H3 uses hexagons: uniform neighbor distances). Uber built H3 for this.

Keep the **live index in memory**: Redis GEO (\`GEOADD\`/\`GEOSEARCH\`) or a custom in-memory service sharded by cell/city. Each driver's update moves them between cells; stale drivers expire via TTL.

## 4. Architecture
- Drivers' apps → (WebSocket/HTTP) → **location service** → in-memory geo index (sharded by region/cell). Updates also stream to Kafka for trip tracking, analytics and ETA models; writing every update synchronously to a durable DB is unnecessary.
- Rider requests → **dispatch/matching service**: query nearby available drivers, rank by ETA (road network, not straight-line distance), offer to one driver at a time (or a few), with timeouts.
- **Driver state** (available / offered / on-trip) needs atomic transitions: compare-and-set in a store with strong consistency, so two dispatchers can't grab the same driver.
- Trips, payments, history: durable stores (SQL for trips/payments).

## 5. Partitioning
Shard by **geography**: a city's (or cell range's) drivers and riders are handled by the same shard, so matching is local. Hot spots (stadium letting out) need finer cells or dynamic re-sharding. Uber's Ringpop used consistent hashing with gossip for this.

## 6. Bottlenecks & trade-offs
- Write volume of location updates → memory-first, batch durable writes, drop stale updates.
- Accuracy vs. freshness: 4 s update interval vs battery/data cost.
- Matching fairness and efficiency (global optimization vs greedy nearest).
- Surge pricing computed per cell from supply/demand streams.
- Regional failures: active-active per region; trips in progress must survive.

> **Interview** Lead with the numbers (1M+ writes/s of ephemeral data → in-memory geo index), explain the cell index (geohash/H3), then the atomic driver-state transition to prevent double assignment.

## The lab
Drivers send **~19,000 location updates/s** (one city's worth); riders make ~1,000 matching queries/s. At **30 s** a concert ends and traffic doubles for 20 s. The starter writes every GPS ping into a SQL database.
`,
      quiz: [
        { q: 'Why keep live driver locations in memory rather than a durable SQL table?', options: ['SQL cannot store coordinates', 'Updates are huge in volume, ephemeral and only the latest matters; memory handles 1M+ writes/s cheaply', 'Memory is more durable', 'Regulations require it'], answer: 1, why: 'The live index is a cache of rapidly changing state. Durable history can be written asynchronously in batches.' },
        { q: 'How do you prevent two dispatchers from assigning the same driver?', options: ['Hope it is rare', 'Atomic compare-and-set on driver state (available → offered) in a strongly consistent store', 'Assign by client timestamp', 'Let the driver pick both'], answer: 1, why: 'A conditional update ensures only one dispatcher wins the transition.' },
      ],
      lab: {
        title: 'Track every driver',
        brief: `**20,000 rps**: ~95% are driver **location updates** (writes), the rest are rider matching queries. At **30 s** a concert ends and traffic **doubles for 20 s**.

Writing every GPS ping into SQL is hopeless. Build a **memory-first geo index**: a Cache (Redis GEO) in **write-back** mode in front of a durable store that only receives batched history.

Goals: p99 under **300 ms**, errors under **1%** (losing a ping or two on a crash is acceptable), cost under **$9,000/month**.`,
        duration: 70,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 20000, readRatio: 0.05, rttMs: 60, workingSetGB: 5 }, 'Drivers + riders'],
          ['lb', 'lb', X(1), Y(1.5), { instances: 2 }],
          ['app', 'app', X(2), Y(1.5), { instances: 30, size: 'M', baseMs: 5 }, 'Location svc'],
          ['db', 'sqldb', X(3), Y(1.5), { size: 'XL' }, 'Locations DB'],
        ], ['u>lb', 'lb>app', 'app>db']),
        events: [{ at: 30, do: 'spike', factor: 2, duration: 20 }],
        goals: [
          { metric: 'p99', op: '<', value: 300, label: 'p99 under 300 ms', after: 6 },
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 6 },
          { metric: 'cost', op: '<', value: 9000, label: 'Cost under $9k/month', after: 0 },
        ],
        hints: [
          'Add a **Cache** with strategy **write-back** between Location svc and storage (Location svc → Cache → store). Writes are acked from memory and flushed in batches (~30% of the volume).',
          'Even batched, 38k (spike) × 0.3 writes/s × 4 units is too much for one SQL primary. Use **NoSQL** (RF 3, consistency ONE) behind the cache for history, sized for the spike: ~11k writes × 3 ≈ 34k units.',
          'The location service and load balancers also need headroom for the 2× spike (40k rps). Size them for the peak.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 20000, readRatio: 0.05, rttMs: 60, workingSetGB: 5 }, 'Drivers + riders'],
          ['lb', 'lb', X(1), Y(1.5), { instances: 3 }],
          ['app', 'app', X(2), Y(1.5), { instances: 55, size: 'M', baseMs: 5 }, 'Location svc'],
          ['cache', 'cache', X(3), Y(1.5), { memoryGB: 16, nodes: 2, strategy: 'write-back', ttlSec: 30 }, 'Geo index (Redis)'],
          ['db', 'nosql', X(4), Y(1.5), { nodes: 10, rf: 3, consistency: 'ONE' }, 'Location history'],
        ], ['u>lb', 'lb>app', 'app>cache', 'cache>db']),
        debrief: 'Treating location as ephemeral, memory-first state made the impossible routine. The durable store sees a fraction of the writes, and losing a few seconds of pings on a cache crash is acceptable here (never for payments!). Note how the spike forced headroom in every tier, including the load balancers.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'payments',
      title: 'Design a payment system',
      minutes: 45,
      summary: 'Correctness over everything: never charge twice, never lose a payment, always be able to explain every cent. Idempotency, ledgers, reconciliation and unreliable third parties.',
      calculator: { dau: 10000000, readsPerUser: 3, writesPerUser: 1, recordKB: 2, peak: 5, years: 7, replication: 3, serverRps: 500 },
      body: `${FRAME}
## 1. Requirements

**Functional**: accept payments (cards, wallets) via external payment service providers (PSPs: Stripe, Adyen, banks); refunds; payouts to sellers; payment status and history; webhooks to merchants.

**Non-functional**: **exactly-once effects** (no double charge, no lost payment), strong consistency for money, full auditability, PCI-DSS compliance, high availability. Throughput is modest compared with social apps (hundreds to thousands of TPS); **correctness** is the hard part.

## 2. Core flow
1. Client checks out → \`POST /payments\` with an **idempotency key** (generated client-side per checkout attempt).
2. Payment service creates a \`payment\` record in state **PENDING** (same transaction: the idempotency key with a unique constraint).
3. Calls the PSP with *its own* idempotency key (PSPs support this too).
4. PSP responds: success/failure, or **times out**, in which case the outcome is **unknown**.
5. Update state → **SUCCEEDED/FAILED**; write **ledger entries**; emit \`PaymentSucceeded\` (outbox) → order service, notifications, merchant webhooks.

## 3. Handling unknown outcomes
A timeout does **not** mean failure; the card may have been charged. Never just retry blindly with a new request. Instead:
- Retry with the **same idempotency key** (the PSP dedupes).
- Or query the PSP for status; listen for PSP **webhooks**.
- A **reconciliation** job compares your records with the PSP's settlement reports daily and flags mismatches.

## 4. The ledger: double-entry bookkeeping
Every money movement is recorded as balanced entries: debit one account, credit another; **the sum is always zero**. Ledger rows are **append-only** (never update or delete; corrections are new entries). Balances are derived (or cached with care). This makes the system auditable and bugs detectable.

\`\`\`
txn 981: debit  customer_card_clearing  $50.00
         credit merchant_payable         $48.55
         credit platform_fees             $1.45
\`\`\`

## 5. Data & consistency
- Payments and ledger in a **relational database** with ACID transactions, synchronous replication (RPO = 0), and serializable or carefully locked updates for balances.
- State machine with valid transitions only (PENDING → SUCCEEDED | FAILED; SUCCEEDED → REFUNDED…), enforced with conditional updates.
- Idempotency table: \`(key, request_hash, response, created_at)\`, unique on key; reject reuse with a different payload.

## 6. Reliability patterns
- **Async processing**: accept the payment intent quickly; process via a durable queue with workers. The client polls or receives a webhook. Absorbs PSP slowness.
- **Timeouts, retries with backoff, circuit breakers** around PSPs; route to a backup PSP when one is degraded.
- **Exactly-once** = at-least-once delivery + idempotent consumers + idempotent PSP calls.
- **Security**: never store raw card numbers; tokenize via the PSP/vault; minimize PCI scope.

> **Interview** Say "idempotency key" in the first two minutes, then explain what happens on a PSP timeout (unknown state → same-key retry or status query, plus reconciliation). Mention the double-entry ledger. These three points separate strong answers from average ones.

## The lab
**600 payment requests/s**. The API calls the PSP synchronously (~300 ms), with client retries but **no idempotency keys**. At **25 s** the PSP becomes 10× slower for 25 s. Timeouts → retries → **double charges**. Make it correct first, then resilient.
`,
      quiz: [
        { q: 'A PSP call times out. What is the right next step?', options: ['Mark the payment failed and ask the user to pay again', 'Retry with the same idempotency key, or query the PSP for the payment status', 'Retry with a new request', 'Refund the customer'], answer: 1, why: 'The outcome is unknown. The same key makes the retry safe; status queries and reconciliation resolve the truth.' },
        { q: 'Why is the ledger append-only?', options: ['Databases are faster at inserts', 'Every cent must be traceable: corrections are new balancing entries, never edits that erase history', 'Regulations forbid indexes', 'To save storage'], answer: 1, why: 'Immutability plus double-entry (debits = credits) makes errors detectable and the history auditable.' },
      ],
      lab: {
        title: 'Never charge twice',
        brief: `**600 rps** of payments (80% writes). The **Payments API** calls the **PSP** synchronously; clients retry; **no idempotency keys** anywhere. At **25 s** the PSP turns 10× slower until 50 s.

Goals:
- **Zero duplicate charges** for the whole run,
- **zero lost writes** (no write-back caches; durable stores),
- availability ≥ **97%**.

Hint: correctness first (idempotency), then resilience (async processing, timeouts).`,
        duration: 70,
        graph: G([
          ['u', 'client', X(0), Y(1.2), { rps: 600, readRatio: 0.2, retries: 2, backoff: false, timeoutMs: 1500, idempotency: false, rttMs: 60 }, 'Checkout clients'],
          ['lb', 'lb', X(1), Y(1.2)],
          ['api', 'app', X(2), Y(1.2), { instances: 4, retries: 1, timeoutMs: 0 }, 'Payments API'],
          ['psp', 'external', X(3), Y(0.2), { latencyMs: 300, quotaRps: 3000, errorRate: 0.01 }, 'PSP'],
          ['db', 'sqldb', X(3), Y(2.2), { size: 'M' }, 'Payments + ledger'],
        ], ['u>lb', 'lb>api', 'api>psp', 'api>db']),
        events: [{ at: 25, do: 'slow', target: 'psp' }, { at: 50, do: 'unslow', target: 'psp' }],
        goals: [
          { metric: 'duplicates', op: '<=', value: 0, label: 'Zero duplicate charges', after: 0 },
          { metric: 'lostWrites', op: '<=', value: 0, label: 'Zero lost writes', at: 'end' },
          { metric: 'availability', op: '>=', value: 0.97, label: 'Availability ≥ 97%', at: 'end' },
        ],
        hints: [
          'Turn on **Idempotency keys** on both the clients and the Payments API. Retries then can’t create a second charge.',
          'Even with idempotency, a synchronous 3-second PSP call exhausts the API’s threads. Make processing async: Payments API → **Queue** → **Workers** → PSP and DB. The API just records the intent and returns.',
          'Give the workers idempotency keys and a timeout too. They retry PSP calls, and redelivered messages must not double charge.',
          'Watch what happens when the PSP recovers: workers drain the backlog at full speed and can swamp the database (a "thundering backlog"). Don’t over-provision workers, and give the ledger DB headroom (L).',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.2), { rps: 600, readRatio: 0.2, retries: 2, backoff: true, timeoutMs: 1500, idempotency: true, rttMs: 60 }, 'Checkout clients'],
          ['lb', 'lb', X(1), Y(1.2)],
          ['api', 'app', X(2), Y(1.2), { instances: 4, retries: 0, timeoutMs: 500, idempotency: true }, 'Payments API'],
          ['q', 'queue', X(3), Y(0.4), { partitions: 12 }, 'payment-intents'],
          ['wk', 'worker', X(4), Y(0.4), { instances: 6, retries: 2, timeoutMs: 4000, idempotency: true }, 'Payment workers'],
          ['psp', 'external', X(5), Y(0), { latencyMs: 300, quotaRps: 3000, errorRate: 0.01 }, 'PSP'],
          ['db', 'sqldb', X(5), Y(1.6), { size: 'L', replication: 'sync' }, 'Payments + ledger'],
        ], ['u>lb', 'lb>api', 'api>q', 'api>db', 'q>wk', 'wk>psp', 'wk>db']),
        debrief: 'Idempotency keys made retries harmless; the queue + workers turned a slow PSP into a backlog instead of an outage, and the API stayed responsive ("payment processing…"). In a real system you would also add a daily reconciliation job against the PSP’s settlement report: the last line of defense.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'notifications',
      title: 'Design a notification system',
      minutes: 35,
      summary: 'Send the right message, on the right channel, exactly once, without melting third-party providers when a breaking-news event fires millions of notifications at once.',
      calculator: { dau: 100000000, readsPerUser: 1, writesPerUser: 5, recordKB: 1, peak: 10, years: 1, replication: 3, serverRps: 2000 },
      body: `${FRAME}
## 1. Requirements

**Functional**: services trigger notifications (order shipped, new message, breaking news) to users over **push (APNs/FCM), email, SMS, in-app**; user preferences and opt-outs; templates and localization; scheduling; delivery tracking.

**Non-functional**: high throughput with **bursts** (a broadcast to 50M users), at-least-once delivery without spamming duplicates, respect provider **rate limits**, low latency for transactional messages (2FA codes!), isolation so a slow channel doesn't delay others.

## 2. Architecture
1. **Notification API**: producers call \`POST /notify {userIds|segment, template, data, priority}\`. Validate, then **enqueue**; never deliver inline.
2. **Fan-out / routing service**: expand segments to users, look up **preferences** (channels, quiet hours, opt-outs) and device tokens/emails, render templates, and publish per-channel messages.
3. **Per-channel queues + workers**: push, email, SMS each have their own topic and worker pool, sized to that provider's quota and latency. A slow SMS provider can't block push.
4. **Providers**: APNs, FCM, SES/SendGrid, Twilio. Each has quotas, latency and failure modes.
5. **Tracking**: delivery/open events → analytics; dead tokens → cleanup.

## 3. Priorities
Separate queues (or priority lanes) for **transactional** (OTP, security alerts: seconds matter) vs **marketing/broadcast** (minutes are fine). A 50M-user campaign must never delay someone's login code.

## 4. Reliability
- **At-least-once** delivery from queues + **dedupe** with a notification ID (idempotency key) checked before sending, so retries don't double-notify.
- Retries with backoff for provider 5xx/429; **DLQ** for permanent failures (invalid token → unregister device).
- **Rate limiting toward providers**: token buckets per provider (and per app/tenant); smooth bursts through the queue instead of exceeding quotas and getting throttled or banned.
- **User-level limits**: don't send 40 pushes in a minute; collapse/digest.

## 5. Data
- Preferences & device tokens: KV/NoSQL keyed by user_id (hot reads → cache).
- Templates: SQL with versioning.
- Notification log: write-heavy, time-series-ish (Cassandra), TTL'd.

## 6. Bottlenecks & trade-offs
- Broadcast fan-out of tens of millions: batch, partition by user, scale workers on queue depth, accept minutes of lag for non-urgent sends.
- Provider quotas bound throughput; nothing you build can exceed them, but the queue keeps you from losing messages.
- Exactly-once is impossible end-to-end (providers can deliver twice); dedupe where you can, and use collapse keys for push.

> **Interview** Emphasize: async via queues, per-channel isolation, priority lanes, provider rate limiting, idempotent sends, preference checks. Draw the queue fan-out clearly.

## The lab
**2,000 notifications/s** normally; at **20 s** a breaking-news event triggers ×5 for 15 s. Every notification goes out over **push** and **email**. The starter calls both providers synchronously from the API, and the email provider's quota is 3,000/s.
`,
      quiz: [
        { q: 'Why separate queues for OTP codes and marketing campaigns?', options: ['They use different databases', 'So a huge campaign backlog never delays time-critical messages', 'Providers require it', 'To save money'], answer: 1, why: 'Priority isolation keeps transactional latency low even when bulk traffic floods the system.' },
        { q: 'The email provider allows 3,000 sends/s and a broadcast needs 10,000/s. What should the system do?', options: ['Send 10,000/s and ignore 429s', 'Queue and drain at ≤ 3,000/s with a rate limiter; accept minutes of lag for bulk email', 'Drop 70% of emails', 'Switch everything to SMS'], answer: 1, why: 'You can’t exceed a provider’s quota. Smoothing through the queue avoids throttling and data loss.' },
      ],
      lab: {
        title: 'Breaking news',
        brief: `**2,000 notifications/s**; at **20 s** breaking news triggers **×5 for 15 s**. Each notification goes to **push** and **email**.

The starter API calls both providers synchronously. When the burst hits, the **email quota (3,000/s)** is blown and requests fail.

Re-architect with a **pub-sub Queue** and one **Worker** group per channel, each sized to stay under its provider's quota. Goals: API errors under **0.5%**, API p99 under **300 ms**, consumer lag under **60 s** at the end of the run.`,
        duration: 90,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 2000, readRatio: 0, rttMs: 30, retries: 1 }, 'Producer services'],
          ['lb', 'lb', X(1), Y(1.5)],
          ['api', 'app', X(2), Y(1.5), { instances: 10 }, 'Notification API'],
          ['pushp', 'external', X(3), Y(0.5), { latencyMs: 80, quotaRps: 20000, errorRate: 0.003 }, 'APNs / FCM'],
          ['mail', 'external', X(3), Y(2.5), { latencyMs: 250, quotaRps: 3000, errorRate: 0.005 }, 'Email provider'],
        ], ['u>lb', 'lb>api', 'api>pushp', 'api>mail']),
        events: [{ at: 20, do: 'spike', factor: 5, duration: 15 }],
        goals: [
          { metric: 'errRate', op: '<', value: 0.005, label: 'API errors under 0.5%', after: 5 },
          { metric: 'p99', op: '<', value: 300, label: 'API p99 under 300 ms', after: 5 },
          { metric: 'consumerLag', op: '<', value: 60, label: 'Consumer lag under 60 s at the end', at: 'end' },
        ],
        hints: [
          'Notification API → **Queue** (mode **pub-sub**). Add two **Workers**: Queue → Push workers → APNs/FCM, and Queue → Email workers → Email provider. Remove the API’s direct provider links.',
          'Email workers must drain below 3,000/s or the provider rejects them. Each email call holds a worker thread ~275 ms, so an S worker manages ~360/s (100 threads ÷ 0.275 s). **8 workers ≈ 2,900/s**: the burst becomes backlog and drains afterwards.',
          'Partitions must be ≥ the largest worker group. Push workers can run faster: its quota is 20k/s.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 2000, readRatio: 0, rttMs: 30, retries: 1 }, 'Producer services'],
          ['lb', 'lb', X(1), Y(1.5)],
          ['api', 'app', X(2), Y(1.5), { instances: 14, size: 'M' }, 'Notification API'],
          ['q', 'queue', X(3), Y(1.5), { partitions: 24, mode: 'pub-sub' }, 'notifications'],
          ['wp', 'worker', X(4), Y(0.5), { instances: 20 }, 'Push workers'],
          ['we', 'worker', X(4), Y(2.5), { instances: 8 }, 'Email workers'],
          ['pushp', 'external', X(5), Y(0.5), { latencyMs: 80, quotaRps: 20000, errorRate: 0.003 }, 'APNs / FCM'],
          ['mail', 'external', X(5), Y(2.5), { latencyMs: 250, quotaRps: 3000, errorRate: 0.005 }, 'Email provider'],
        ], ['u>lb', 'lb>api', 'api>q', 'q>wp', 'q>we', 'wp>pushp', 'we>mail']),
        debrief: 'The queue turned a burst the email provider could never accept into a backlog it drained at a sustainable rate, while push kept up in real time thanks to its own worker group. Per-channel isolation, provider-aware rate, async everything: that is the whole notification system pattern.',
      },
    },
  ],
};
