import { G, X, Y } from './util.js';

export default {
  week: '5–6',
  title: 'Caching & Traffic Management',
  lessons: [
    // ------------------------------------------------------------------
    {
      id: 'caching',
      title: 'Redis & cache invalidation',
      minutes: 35,
      summary: 'A cache answers from memory in under a millisecond and shields your database from repetitive reads. Getting the data in, keeping it fresh, and surviving when the cache goes cold is the hard part.',
      body: `
## Why cache?

Reads are usually skewed: a small fraction of keys (the hot set) gets most of the traffic. Keep those in memory and you:
- cut latency (Redis GET ~0.5 ms vs. a DB query 5–50 ms),
- cut database load by the **hit ratio** (95% hits → the DB sees 1/20th of reads),
- cut cost (memory is cheaper than database capacity for hot reads).

Caches live at many layers: browser → CDN → API gateway → in-process (local LRU) → distributed (Redis, Memcached) → database buffer pool.

## Caching patterns

**Cache-aside (lazy loading)**: the most common.
\`\`\`
read:  v = cache.get(k); if miss: v = db.query(k); cache.set(k, v, ttl)
write: db.update(k); cache.delete(k)
\`\`\`
Only requested data is cached; a cache failure degrades to DB reads. Stale reads are possible within the TTL or in races.

**Read-through**: the cache itself loads from the DB on a miss (the application talks only to the cache).

**Write-through**: writes go to the cache, which synchronously writes the DB. The cache is always fresh, but writes are slower and you cache data that may never be read.

**Write-behind (write-back)**: writes are acknowledged by the cache and flushed to the DB asynchronously in batches. Huge write throughput, but **data loss if the cache dies before flushing**. Use it only for data you can lose or rebuild (counters, analytics).

**Refresh-ahead**: proactively refresh hot keys before they expire.

## Eviction

When memory fills, something must go: **LRU** (least recently used, the default choice), **LFU** (least frequently used; better for stable popularity), **TTL-based** expiry, or random. Redis offers \`allkeys-lru\`, \`allkeys-lfu\`, \`volatile-ttl\` and more.

Hit ratio depends on **memory vs. working set**. If the hot data is 20 GB and the cache has 4 GB, expect lots of misses; with 64 GB, nearly everything hits.

## Invalidation: one of the two hard things

> "There are only two hard things in Computer Science: cache invalidation and naming things." (Phil Karlton)

Strategies, from simplest:
1. **TTL only**: data can be stale for up to the TTL. Fine for feeds, counts, recommendations.
2. **Delete on write** (cache-aside): delete the key after updating the DB.
3. **Update on write** (write-through).
4. **Event-driven invalidation**: subscribe to the DB change stream (CDC) and invalidate precisely.
5. **Versioned keys**: \`user:42:v7\`. Bump the version on write and old entries simply age out.

The classic race with cache-aside: reader A misses and reads **old** value from DB → writer B updates DB and deletes key → A writes the old value into the cache. Mitigations: short TTLs as a safety net, delete-after-write *plus* a delayed second delete, or versioned writes (set only if newer).

## Cache stampede (thundering herd)

A hot key expires, or the cache restarts **cold**, and thousands of concurrent requests miss at once and all hit the database for the same data. The DB melts, the cache can't be refilled, and you're down.

Defenses:
- **Request coalescing / single-flight**: only one request recomputes a key; the rest wait for its result.
- **Locks / leases** on recompute (Memcached leases).
- **Probabilistic early expiration**: refresh a little before the TTL, randomly, so not everyone expires together.
- **Stale-while-revalidate**: serve the slightly stale value while one worker refreshes it.
- **Jittered TTLs** so keys don't expire in sync.
- **Warm the cache** before sending traffic to a new node.

## Redis in production

- Data structures beyond strings: hashes, lists, sets, **sorted sets** (leaderboards, timelines), streams, HyperLogLog, geo. Often the reason to choose Redis over Memcached.
- Single-threaded command execution: one slow command (\`KEYS *\`, huge \`SMEMBERS\`) blocks everyone.
- Persistence (RDB snapshots, AOF log) exists, but treat a cache as **disposable** unless it is your system of record.
- Scale with **Redis Cluster** (16,384 hash slots spread across shards) and replicas; Sentinel or managed services for failover.
- ~100k+ ops/s per node; latency is usually network-bound.

> **Interview** Say what you cache (and the key format), the pattern (usually cache-aside), the TTL and invalidation trigger, expected hit ratio, and what happens when the cache dies (fallback to DB, so make sure the DB survives a cold start or protect it with coalescing).

## The lab

7,600 reads/s are hammering the database. Add a cache. Then at **30 s** the cache node crashes and restarts **empty**. Without protection the cold cache sends a stampede at the database right as it is recovering.
`,
      quiz: [
        { q: 'Which pattern risks losing acknowledged writes if the cache crashes?', options: ['Cache-aside', 'Read-through', 'Write-through', 'Write-behind (write-back)'], answer: 3, why: 'Write-back acknowledges before the DB has the data. Anything still buffered when the node dies is gone.' },
        { q: 'A hot key with TTL 60s expires and 5,000 requests miss simultaneously. Best mitigation?', options: ['Increase TTL to 1 day', 'Request coalescing / single-flight so only one request recomputes it', 'Add more app servers', 'Disable the cache'], answer: 1, why: 'Coalescing collapses the 5,000 concurrent misses into one DB query. Longer TTLs only delay the problem and add staleness.' },
        { q: 'With cache-aside, why delete the key on write rather than update it?', options: ['Deletes are faster than sets', 'It avoids writing a value computed from a possibly stale read, and avoids caching data nobody reads', 'Redis does not support updates', 'It makes the cache write-through'], answer: 1, why: 'Deleting lets the next reader repopulate from the source of truth. Updating in place can race with other writers and leave the cache wrong.' },
      ],
      lab: {
        title: 'Cache it, then survive a cold start',
        brief: `**8,000 rps** (95% reads) against an L-size primary that can't keep up.

1. Add a **Cache (Redis)**: connect **App → Cache** and **Cache → SQL Primary** (misses fall through to the DB). Keep **App → SQL Primary** for writes.
2. At **30 s** the cache crashes, and it comes back **cold** at 33 s.

Pass with availability ≥ **95%**, stale reads under **1%**, and p99 under **300 ms** by the end of the run.`,
        duration: 80,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 8000, readRatio: 0.95, workingSetGB: 20, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 20 }],
          ['db', 'sqldb', X(4), Y(1), { size: 'L' }],
        ], ['u>lb', 'lb>app', 'app>db']),
        events: [{ at: 30, do: 'kill', target: 'cache' }, { at: 33, do: 'restore', target: 'cache' }],
        goals: [
          { metric: 'availability', op: '>=', value: 0.95, label: 'Availability ≥ 95% over the run', at: 'end' },
          { metric: 'staleRate', op: '<', value: 0.01, label: 'Stale reads under 1%', after: 6 },
          { metric: 'p99', op: '<', value: 300, label: 'p99 under 300 ms at the end', at: 'end' },
        ],
        hints: [
          'Drag in **Cache (Redis)** and wire App → Cache → SQL Primary. The 30 s chaos event crashes your cache, whatever you name it.',
          'The hot set is 20 GB. A 32 GB cache hits ~95%. Keep the TTL moderate: very long TTLs with cache-aside raise stale reads.',
          'When the cache comes back cold, misses on the same hot keys pile onto the DB together. Turn on **Request coalescing**.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 8000, readRatio: 0.95, workingSetGB: 20, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 20 }],
          ['cache', 'cache', X(3), Y(0.2), { memoryGB: 32, ttlSec: 120, coalescing: true }],
          ['db', 'sqldb', X(4), Y(1), { size: 'L' }],
        ], ['u>lb', 'lb>app', 'app>cache', 'cache>db', 'app>db']),
        debrief: 'The cache took ~95% of reads off the database, until it died. During the outage the app fell back to the DB (which saturated), and when the cache returned cold, coalescing stopped duplicate misses from multiplying the load. Remember: **your database must survive a cold cache**, or the cache becomes a single point of failure.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'cdn',
      title: 'CDN & edge caching',
      minutes: 25,
      summary: 'Content delivery networks put copies of your bytes in hundreds of locations near users. They cut latency, offload your origin, and slash bandwidth bills.',
      body: `
## How a CDN works

A CDN (Cloudflare, Akamai, CloudFront, Fastly) operates **points of presence (PoPs)** in hundreds of cities. Users are routed to a nearby PoP via **anycast** or DNS. The PoP serves the response from its cache if it has it (**hit**); otherwise it fetches from your **origin** (**miss**), caches it, and serves it.

Why it matters:
- **Latency**: a user in Mumbai fetching from Virginia pays ~200 ms per round trip; from a Mumbai PoP, ~10 ms. TLS and TCP handshakes terminate at the edge too.
- **Offload**: with a 95% hit ratio your origin serves 1 in 20 asset requests.
- **Cost**: CDN egress is far cheaper than cloud egress from your origin, especially at volume.
- **Resilience**: CDNs absorb traffic spikes and DDoS attacks, and can serve stale content if your origin is down.

## What to put on a CDN

- **Static assets**: JS, CSS, fonts, images: long TTLs with **content-hashed filenames** (\`app.3f9a1c.js\`), so a deploy is a new URL and never needs a purge.
- **Media**: images (often resized at the edge), video segments (HLS/DASH chunks): the bulk of internet bytes.
- **Cacheable API responses**: public, identical-for-everyone data (product pages, scores, config) with short TTLs (seconds), plus \`stale-while-revalidate\`.
- **Dynamic, personalized responses**: not cached, but still benefit from the edge: connection reuse to origin, TLS termination, optimized routing ("dynamic site acceleration").

## Controlling caching

HTTP headers drive everything:
\`\`\`
Cache-Control: public, max-age=31536000, immutable        # hashed assets
Cache-Control: public, s-maxage=30, stale-while-revalidate=60   # API at edge
Cache-Control: private, no-store                           # personal data
\`\`\`
- **Cache key**: by default URL + host; you can add headers/cookies (careful: each variant fragments the cache and lowers hit ratio).
- **Purge/invalidation**: by URL, tag or prefix; usually seconds, but prefer versioned URLs.
- **Origin shield**: a mid-tier cache so 300 PoPs missing simultaneously produce 1 origin request, not 300.
- **Signed URLs/cookies** for private content (paid videos).

## Edge compute

Workers/Lambda@Edge run code at the PoP: auth checks, A/B routing, header rewrites, image transforms, even full apps with edge KV stores. Keep it small and stateless.

> **Numbers** Typical CDN hit ratios: 90–99% for static assets, lower for long-tail media. Egress pricing (rough): cloud origin ~$0.05–0.09/GB vs. CDN ~$0.01–0.04/GB at scale. Video is ~80% of internet traffic, and all of it rides on CDNs.

> **Interview** For any media-heavy system (Instagram, YouTube, Netflix), say: "uploads go to object storage; reads are served via CDN with long-TTL, versioned URLs; the origin only sees misses." Then talk about cache hit ratio and cost.

## The lab

A content site serves **20,000 rps** to users far from the origin (120 ms RTT). 75% of requests are 25 KB thumbnails, served by the app servers, which costs CPU and enormous origin bandwidth. Put a CDN and object storage in front.
`,
      quiz: [
        { q: 'You deploy a new app.js but users keep getting the old file for a day. Best fix for the future?', options: ['Purge the CDN after every deploy', 'Disable CDN caching for JS', 'Content-hashed filenames (app.<hash>.js) with long TTLs', 'Lower TTL to 1 second'], answer: 2, why: 'A new hash means a new URL, so there is nothing stale to purge, and the old file can stay cached forever.' },
        { q: 'Which response should NOT be cached at a shared CDN edge?', options: ['A product image', "GET /me returning the logged-in user's profile", 'Football scores updated every 10s', 'A versioned CSS bundle'], answer: 1, why: 'Personalized responses must be private/no-store, or users could see each other’s data.' },
      ],
      lab: {
        title: 'Move the bytes to the edge',
        brief: `**20,000 rps** from users ~120 ms from the origin. **75%** are 25 KB image thumbnails that the app servers read and stream themselves. That burns CPU and costs a fortune in origin egress.

Add a **CDN** in front (Users → CDN → Load Balancer) and an **Object Storage** bucket as the image origin (CDN → Object Storage).

Pass with p99 under **400 ms**, errors under 1%, and cost under **$60,000/month**. Yes, bandwidth really is that expensive at this scale: ~1 PB a month.`,
        duration: 45,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 20000, readRatio: 0.98, staticRatio: 0.765, staticKB: 25, rttMs: 120 }],
          ['lb', 'lb', X(1.5), Y(1), { instances: 2 }],
          ['app', 'app', X(2.5), Y(1), { instances: 40, size: 'M' }],
          ['cache', 'cache', X(3.5), Y(0.3), { memoryGB: 32 }],
          ['db', 'sqldb', X(3.5), Y(1.7), { size: 'L' }],
        ], ['u>lb', 'lb>app', 'app>cache', 'cache>db', 'app>db']),
        goals: [
          { metric: 'p99', op: '<', value: 400, label: 'p99 under 400 ms', after: 6 },
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 6 },
          { metric: 'cost', op: '<', value: 60000, label: 'Cost under $60k/month', after: 3 },
        ],
        hints: [
          'Add a **CDN** and rewire: Users → CDN, CDN → Load Balancer. Delete the direct Users → Load Balancer link.',
          'Add **Object Storage** and connect CDN → Object Storage: image misses go there instead of through your app servers.',
          'Once images are off the app tier you need far fewer app servers. Check their CPU and scale down to save money.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 20000, readRatio: 0.98, staticRatio: 0.765, staticKB: 25, rttMs: 120 }],
          ['cdn', 'cdn', X(1), Y(1), { staticHit: 0.95 }],
          ['blob', 'blob', X(2), Y(0)],
          ['lb', 'lb', X(2), Y(1.5), { instances: 1 }],
          ['app', 'app', X(3), Y(1.5), { instances: 12, size: 'S' }],
          ['cache', 'cache', X(4), Y(0.9), { memoryGB: 32 }],
          ['db', 'sqldb', X(4), Y(2.2), { size: 'L' }],
        ], ['u>cdn', 'cdn>blob', 'cdn>lb', 'lb>app', 'app>cache', 'cache>db', 'app>db']),
        debrief: 'Images now come from a nearby edge in ~20 ms instead of crossing an ocean, the app tier only handles API calls, and bandwidth costs dropped by roughly two thirds. Look at the Trace tab with "Static asset" selected: the whole request now ends at the CDN.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'load-balancing',
      title: 'Load balancing',
      minutes: 25,
      summary: 'Load balancers spread traffic, hide failures and enable zero-downtime deploys. The algorithm and health checks you choose decide whether one bad server becomes everyone’s problem.',
      body: `
## What a load balancer does

Sits between clients and a pool of servers and:
- **Distributes** requests across healthy targets,
- **Detects failures** via health checks and stops routing to broken targets,
- **Terminates TLS** (offloading crypto from app servers),
- enables **rolling deploys** (drain a server, update it, add it back),
- provides one stable address while the fleet changes underneath.

## Layer 4 vs. Layer 7

| | L4 (transport) | L7 (application) |
|---|---|---|
| Sees | IPs, ports, TCP/UDP | HTTP: paths, headers, cookies |
| Routing | Per connection | Per request (path-based, header-based) |
| Speed | Very fast, millions of conns | More CPU per request |
| Examples | AWS NLB, LVS, Maglev | NGINX, HAProxy, Envoy, AWS ALB |

L7 enables routing \`/api/*\` and \`/static/*\` to different pools, retries, canary releases, and per-request balancing of long-lived HTTP/2 connections.

## Algorithms

- **Round robin**: next server in turn. Simple; assumes equal servers and equal requests.
- **Weighted round robin**: bigger servers get proportionally more.
- **Least connections / least outstanding requests**: send to the target with the fewest in-flight requests. Adapts automatically to slow servers and uneven request costs.
- **Least response time / EWMA**: prefer the fastest recent responders.
- **Power of two choices**: pick 2 random servers, send to the less loaded. Nearly as good as global least-conn with no global state, so it is used at huge scale.
- **Hashing (IP hash, consistent hashing)**: the same client/key always goes to the same server. Useful for cache locality or sticky sessions, at the cost of balance.

## Health checks and gray failures

**Active** health checks hit \`/health\` every few seconds; N failures → eject. **Passive** checks watch real traffic for errors.

The hard case is a **gray failure**: a server that passes health checks but is slow (a bad disk, a noisy neighbor, GC thrashing). Round robin keeps sending it 1/N of traffic, and your **p99 becomes that server's latency**. Defenses:
- **Least-connections** naturally sends less to slow servers (requests pile up there).
- **Outlier detection** (Envoy, service meshes) ejects targets whose latency or error rate is much worse than their peers.
- Deep health checks that exercise real dependencies (carefully: a shared dependency failing could eject *every* server).

## The load balancer itself

An LB is a single point of failure unless made redundant: active–passive pairs sharing a virtual IP (keepalived/VRRP), multiple LBs behind DNS, or anycast. Cloud LBs are redundant internally. **Global** load balancing across regions uses DNS (latency/geo routing) or anycast.

## Sticky sessions

Pinning a user to one server (via cookie) lets you keep session state in memory, but uneven load, lost sessions on server death and painful deploys follow. Prefer stateless servers with sessions in Redis or signed tokens.

> **Interview** Mention health checks and what the LB does when a server dies, and name an algorithm with a reason ("least outstanding requests, because request costs vary"). Mention connection draining for deploys.

## The lab

Three app servers behind a round-robin LB **without** health checks. At **20 s** one server turns into a gray failure: 10× slower but still "up". At **45 s** another server dies outright.
`,
      quiz: [
        { q: 'One of 4 servers is 10× slower but passes health checks. With round robin, what happens to p99?', options: ['Unaffected: only 25% of requests are slow', 'p99 becomes roughly the slow server’s latency, since 25% ≫ 1%', 'It improves', 'The LB ejects the server automatically'], answer: 1, why: 'Any server getting ≥1% of traffic defines the p99. A quarter of all requests being slow makes p99 (and p75!) slow.' },
        { q: 'Why is "power of two choices" popular at very large scale?', options: ['It guarantees perfect balance', 'Near-optimal balance using only two random samples, so no global coordination is needed', 'It is the only algorithm that supports TLS', 'It keeps sessions sticky'], answer: 1, why: 'Sampling two and choosing the less loaded dramatically reduces max load compared with random, without a shared view of all servers.' },
      ],
      lab: {
        title: 'Gray failure',
        brief: `Three app servers behind one load balancer, using **round robin** and **no health checks**.

- At **20 s**, *App B* becomes 10× slower but keeps answering (a gray failure).
- At **45 s**, *App C* crashes.

Keep p99 under **500 ms** and availability above **99%** for the whole run. Look at the load balancer's settings, and make sure two servers can carry the full load.`,
        duration: 75,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 1500, readRatio: 0.9, rttMs: 60 }],
          ['lb', 'lb', X(1), Y(1.5), { algorithm: 'round-robin', healthChecks: false }],
          ['a', 'app', X(2), Y(0.5), { instances: 2 }, 'App A'],
          ['b', 'app', X(2), Y(1.5), { instances: 2 }, 'App B'],
          ['c', 'app', X(2), Y(2.5), { instances: 2 }, 'App C'],
          ['db', 'sqldb', X(3), Y(1.5), { size: 'M' }],
        ], ['u>lb', 'lb>a', 'lb>b', 'lb>c', 'a>db', 'b>db', 'c>db']),
        events: [{ at: 20, do: 'slow', target: 'b' }, { at: 45, do: 'kill', target: 'c' }],
        goals: [
          { metric: 'p99', op: '<', value: 500, label: 'p99 under 500 ms', after: 5 },
          { metric: 'availability', op: '>=', value: 0.99, label: 'Availability ≥ 99%', at: 'end' },
        ],
        hints: [
          'Turn on **Health checks** so the dead server is ejected within seconds.',
          'Health checks don’t catch the slow server: it still answers. Turn on **Outlier detection** (or least-connections, which helps but still sends it some traffic).',
          'After B is ejected and C dies, only App A is left. Give each group enough instances that one group can carry 1,500 rps (~4 S instances).',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 1500, readRatio: 0.9, rttMs: 60 }],
          ['lb', 'lb', X(1), Y(1.5), { algorithm: 'least-connections', healthChecks: true, outlierDetection: true }],
          ['a', 'app', X(2), Y(0.5), { instances: 4 }, 'App A'],
          ['b', 'app', X(2), Y(1.5), { instances: 4 }, 'App B'],
          ['c', 'app', X(2), Y(2.5), { instances: 4 }, 'App C'],
          ['db', 'sqldb', X(3), Y(1.5), { size: 'M' }],
        ], ['u>lb', 'lb>a', 'lb>b', 'lb>c', 'a>db', 'b>db', 'c>db']),
        debrief: 'Health checks handle **fail-stop** failures; **gray failures** need latency-aware balancing or outlier detection. Notice too that after losing two of three groups the survivor had to carry everything. Redundancy only counts if the remaining capacity is enough.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'rate-limiting',
      title: 'Rate limiting',
      minutes: 25,
      summary: 'Rate limiting protects your system from abuse, runaway clients and its own success by rejecting excess requests fast and cheaply, before they consume scarce capacity.',
      body: `
## Why rate limit?

- **Protect capacity**: a traffic spike, a buggy client in a retry loop or a scraper shouldn't take everyone down.
- **Fairness**: one tenant can't starve others (per-user/per-key quotas).
- **Cost control**: expensive endpoints (LLM calls, SMS, search) get budgets.
- **Security**: slow down credential stuffing, brute force, enumeration.

A rejected request costs microseconds. An accepted request that times out after 30 s in an overloaded system costs a thread, a connection, and the user's patience, and causes retries. **Fast, explicit rejection (HTTP 429) is a feature.**

## Algorithms

**Token bucket**: a bucket holds up to **B** tokens and refills at **r** tokens/s; each request takes one; empty → reject. Allows bursts up to B while enforcing average r. The most common choice (AWS, Stripe).

**Leaky bucket**: requests enter a queue that drains at a constant rate; queue full → reject. Smooths output perfectly but adds **queueing latency**.

**Fixed window counter**: count requests per calendar second/minute; reset at the boundary. Cheap, but allows **2× bursts** across a boundary (limit at 12:00:59 and again at 12:01:00).

**Sliding window log**: keep timestamps of recent requests; exact, but memory-heavy.

**Sliding window counter**: weight the previous window's count by overlap. Close to exact, cheap. A good default for per-user limits.

| | Bursts | Memory | Precision |
|---|---|---|---|
| Token bucket | Allowed up to B | O(1) | Good |
| Leaky bucket | Smoothed (queued) | O(B) | Good |
| Fixed window | 2× at edges | O(1) | Poor at edges |
| Sliding log | Exact | O(requests) | Exact |
| Sliding counter | Approximate | O(1) | Very good |

## Where to enforce

- **Edge / CDN / WAF**: per-IP, blunt, absorbs attacks before they reach you.
- **API gateway**: per-API-key / per-user / per-route quotas.
- **Service level**: protect each service's own capacity (concurrency limits).
- **Client side**: be a good citizen to third-party APIs.

### Distributed rate limiting

With many gateway instances, counters must be shared: typically **Redis** with atomic \`INCR\` + \`EXPIRE\` or a Lua script implementing a token bucket. Trade-offs: an extra network hop per request, Redis as a dependency (fail open or closed?), and slight over-admission with local caching of tokens.

## Load shedding and backpressure

Rate limiting enforces *policy* limits; **load shedding** protects *capacity*: when a server's queue or latency exceeds a threshold, it rejects new work. **Prioritize**: shed low-value traffic (analytics, prefetch) before checkout. **Backpressure** propagates "slow down" upstream (bounded queues, 429/503 with \`Retry-After\`) instead of letting queues grow unbounded.

> **Interview** "We rate limit at the gateway with a token bucket per API key in Redis, return 429 with Retry-After and X-RateLimit headers, and shed load at the service level when latency SLOs are at risk." Then mention what happens when Redis is down (usually fail open, with a local fallback limit).

## The lab

Your backend comfortably handles ~1.4× normal traffic. At **20 s** a misbehaving partner integration sends a **10× burst** for 15 seconds, and clients retry failures. Without protection the backend collapses and real users get 5xx errors. Put a rate limiter at the front door so the excess gets a cheap 429 and the backend keeps serving everyone else.
`,
      quiz: [
        { q: 'Limit: 100 req/min with a fixed window. What is the worst-case burst a client can achieve?', options: ['100 in any 60s', '~200 within a couple of seconds around the window boundary', '50', 'Unlimited'], answer: 1, why: '100 at 12:00:59 plus 100 at 12:01:00, because the counter resets at the boundary.' },
        { q: 'Why return 429 quickly instead of queuing excess requests indefinitely?', options: ['429 is cached by CDNs', 'Unbounded queues turn overload into timeouts for everyone, consuming resources and triggering retries; fast rejection keeps the system healthy for admitted requests', 'Browsers prefer 429', 'Queues are illegal in HTTP'], answer: 1, why: 'Overload plus unbounded queues means everything gets slow and fails. Bounded admission keeps latency predictable for the traffic you accept.' },
      ],
      lab: {
        title: 'Survive the burst',
        brief: `At **20 s** a partner integration bursts to **10× normal traffic** for 15 s. The backend tops out around ~1.4× normal.

Add an **API Gateway** with rate limiting in front of the load balancer (Users → API Gateway → Load Balancer). Excess requests should get a **429** instead of taking the backend down.

Goals (5xx errors only; 429s don't count as errors): errors under **1%** and p99 under **500 ms** for the whole run.`,
        duration: 60,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 2000, readRatio: 0.9, retries: 2, backoff: false, rttMs: 50 }],
          ['lb', 'lb', X(2), Y(1)],
          ['app', 'app', X(3), Y(1), { instances: 6 }],
          ['db', 'sqldb', X(4), Y(1), { size: 'L' }],
        ], ['u>lb', 'lb>app', 'app>db']),
        events: [{ at: 20, do: 'spike', factor: 10, duration: 15 }],
        goals: [
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors (5xx) under 1%', after: 5 },
          { metric: 'p99', op: '<', value: 500, label: 'p99 under 500 ms', after: 5 },
        ],
        hints: [
          'Drag in an **API Gateway**, connect Users → API Gateway → Load Balancer, and delete Users → Load Balancer.',
          'Set the limit a bit above normal traffic but below backend capacity: normal is 2,000 rps; 6 S instances handle 3,000 at 100%. Try ~2,200 rps with a token bucket.',
          'The burst size matters too: a huge bucket lets the whole spike through in one gulp. And the gateway must be able to *receive* the 20k rps burst in order to reject it: one instance handles ~20k, so run two.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 2000, readRatio: 0.9, retries: 2, backoff: false, rttMs: 50 }],
          ['gw', 'gateway', X(1), Y(1), { rateLimit: true, limitRps: 2200, burst: 200, algorithm: 'token-bucket', instances: 2 }],
          ['lb', 'lb', X(2), Y(1)],
          ['app', 'app', X(3), Y(1), { instances: 6 }],
          ['db', 'sqldb', X(4), Y(1), { size: 'L' }],
        ], ['u>gw', 'gw>lb', 'lb>app', 'app>db']),
        debrief: 'The burst still happened, but excess requests got an instant 429 and admitted ones stayed fast. Without the limiter, the overload turned into timeouts, the timeouts into retries, and the retries into more overload. Rate limiting converts an outage into a degraded-but-healthy state.',
      },
    },
  ],
};
