import { G, X, Y } from './util.js';

export default {
  week: '1–2',
  title: 'System Design Fundamentals',
  lessons: [
    // ------------------------------------------------------------------
    {
      id: 'client-server',
      title: 'Client–server architecture',
      minutes: 15,
      summary: 'Every system you will ever design is a variation of one idea: clients send requests, servers do work and answer. This lesson builds the mental model the rest of the course hangs on.',
      body: `
## The model

A **client** is anything that asks for something: a browser, a mobile app, another service, a cron job. A **server** is a long-running process that listens on a network port, accepts requests, does work, and returns a response. The two talk over a network using an agreed **protocol** (almost always HTTP over TCP, sometimes gRPC, WebSockets or a database's own wire protocol).

What makes this simple model hard at scale:

- **The network is unreliable.** Packets drop, connections reset, latency spikes. Every remote call can fail or hang.
- **Servers are finite.** Each has a fixed amount of CPU, memory, threads and connections. Exceed them and requests queue, then fail.
- **State is the hard part.** Stateless code is easy to copy onto 100 machines. Data has to live somewhere, stay correct, and survive failures.

## The classic three tiers

| Tier | Job | Examples | Scales by |
|---|---|---|---|
| Presentation | Render UI, collect input | Browser, iOS app | Users' own devices |
| Application | Business logic, auth, validation | Java/Go/Node services | Adding identical stateless instances |
| Data | Durable storage, queries | Postgres, Redis, S3 | Replication, partitioning (hard) |

Keep the application tier **stateless**: no user sessions in local memory, no files on local disk. Put state in the data tier (a database, a cache like Redis, object storage). Then any instance can serve any request, instances can die without losing anything, and you scale by adding more of them behind a load balancer.

## Life of a request

When a user taps "Load feed":

1. **DNS lookup**: \`api.example.com\` → an IP address (often cached; ~0–50 ms).
2. **TCP + TLS handshake**: 1–3 round trips before any data flows (this is why connection reuse matters).
3. **Load balancer** picks a healthy app server.
4. **App server** authenticates the user, then calls a cache and/or database.
5. **Database** runs the query, using an index if one exists.
6. The response travels back the same way.

Total latency is the **sum** of every hop on that path, and the **slowest** component sets your ceiling on throughput. That is the whole game: find the bottleneck, relieve it, find the next one.

> **Key idea** Latency adds up along a request's path. Capacity is limited by the narrowest point. Most of system design is managing those two facts.

## Why not one big server?

One server is fine to start, and many real products run for years on one well-tuned database. But one machine means:

- **A single point of failure (SPOF)**: when it dies (and it will), you are down.
- **A hard ceiling**: you can only buy so big a machine.
- **Risky deploys**: every restart is an outage.

Splitting into tiers lets each tier scale and fail independently.

## Peer-to-peer and other shapes

Not everything is client–server. **Peer-to-peer** (BitTorrent, WebRTC calls) has every node acting as both. **Event-driven** systems communicate through a log instead of direct requests (Weeks 9–10). But even those usually have servers for coordination, so the client–server model is the right default.

> **Interview** Start every design by drawing the simplest client → server → database box diagram, then say what breaks first as load grows. Interviewers want to see you evolve a design, not jump to 40 boxes.

## Common mistakes
- Storing sessions or uploaded files on the app server's disk (breaks when you add a second server).
- Letting clients talk straight to the database: no validation, no auth boundary, impossible to change schemas.
- Forgetting that every arrow on a diagram is a network call that can be slow or fail.
`,
      quiz: [
        { q: 'Why should application servers be stateless?', options: ['Stateless code runs faster on a CPU', 'So any instance can serve any request and instances can be added or killed freely', 'Because databases cannot store sessions', 'To avoid needing a load balancer'], answer: 1, why: 'Statelessness makes instances interchangeable. Interchangeable instances are what make horizontal scaling and failure recovery easy.' },
        { q: 'A request passes through an LB (1ms), an app server (20ms) and a DB (8ms). The network RTT is 80ms. Roughly what latency does the user see?', options: ['20 ms', '29 ms', '~110 ms', '80 ms'], answer: 2, why: 'Latencies along a path add up: 80 + 1 + 20 + 8 ≈ 109 ms.' },
      ],
      lab: {
        title: 'Wire your first system',
        brief: `Your users are sending **300 requests/second**, but nothing is connected yet, so every request fails.

1. Drag from the right edge of **Users** (the **●** lights up when you hover) onto the **App Server**. Or click the **●**, then click the App Server.
2. Connect **App Server → SQL Primary**.
3. Press **▶ Run** (or Space) and watch the requests flow. Blue dots are reads, amber are writes.

Then click a component to inspect it while it runs.`,
        duration: 30,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 300 }],
          ['app', 'app', X(1), Y(1), { instances: 1 }],
          ['db', 'sqldb', X(2), Y(1)],
        ], []),
        goals: [
          { metric: 'okRate', op: '>', value: 0.99, label: 'Success rate above 99%', after: 3 },
          { metric: 'p99', op: '<', value: 300, label: 'p99 latency under 300 ms', after: 3 },
        ],
        hints: ['Drag from the small circle on the right edge of the Users card and let go on top of the App Server.', 'The app needs a database too: drag from the App Server’s right-edge circle onto SQL Primary.'],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 300 }],
          ['app', 'app', X(1), Y(1), { instances: 1 }],
          ['db', 'sqldb', X(2), Y(1)],
        ], ['u>app', 'app>db']),
        debrief: 'That is the whole system in miniature: users → stateless compute → durable data. The ~80 ms you see is mostly network round trip. Everything from here on is about what happens when this little system meets more traffic and failures.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'http-dns-rest',
      title: 'HTTP, DNS & REST APIs',
      minutes: 25,
      summary: 'The protocols under every web system: how names become addresses, how requests are framed, and how to design APIs people can actually use.',
      body: `
## DNS: the internet's phone book

DNS turns a name (\`api.example.com\`) into an IP. Resolution walks a hierarchy: your OS cache → a **recursive resolver** (your ISP, 8.8.8.8) → **root** servers → the **.com TLD** servers → your domain's **authoritative** nameserver. Answers are cached at every layer for the record's **TTL**.

Record types you should know: **A/AAAA** (name → IPv4/IPv6), **CNAME** (alias to another name), **NS** (who is authoritative), **MX** (mail), **TXT** (verification, SPF).

DNS is also a **traffic-routing tool**:
- **Round-robin**: return several IPs and let clients spread out.
- **Latency/geo routing**: send users to the nearest region (Route 53, Cloudflare).
- **Health-checked failover**: stop returning a region's IP when its health check fails.

> **Pitfall** DNS failover is only as fast as the TTL. A 1-hour TTL means some clients keep hitting a dead region for an hour. Failover records typically use 30–60 s, and some clients (old JVMs, misbehaving resolvers) ignore TTLs entirely.

## HTTP in one page

HTTP is a request/response protocol: a **method**, a **path**, **headers**, an optional **body**; the reply has a **status code**, headers and a body.

| Method | Meaning | Safe? | Idempotent? |
|---|---|---|---|
| GET | Read a resource | ✓ | ✓ |
| PUT | Replace a resource | ✗ | ✓ |
| DELETE | Remove a resource | ✗ | ✓ |
| POST | Create / trigger an action | ✗ | ✗ |
| PATCH | Partial update | ✗ | not necessarily |

**Idempotent** means repeating it has the same effect as doing it once. This matters enormously for **retries** (Week 7–8): a client can safely retry a GET or PUT after a timeout, but retrying a POST /payments might charge twice unless you add an idempotency key.

Status codes: **2xx** success (200 OK, 201 Created, 204 No Content), **3xx** redirect (301, 304 Not Modified), **4xx** client's fault (400, 401 unauthenticated, 403 forbidden, 404, 409 conflict, **429 Too Many Requests**), **5xx** server's fault (500, 502 bad gateway, **503 unavailable**, 504 gateway timeout).

**Versions:** HTTP/1.1 sends one request at a time per connection (keep-alive reuses connections). HTTP/2 multiplexes many streams over one TCP connection with header compression. HTTP/3 runs over QUIC (UDP), avoiding TCP head-of-line blocking and making handshakes faster, which is great on lossy mobile networks.

**TLS** adds 1 round trip (TLS 1.3) on top of TCP's handshake. On a 100 ms RTT link, a cold HTTPS request costs ~200 ms before the first byte of the request is even sent. Connection pooling and keep-alive are how you avoid paying this per request.

## Designing REST APIs

REST models your system as **resources** (nouns) manipulated with standard methods:

\`\`\`
GET    /v1/users/42            → fetch user 42
GET    /v1/users/42/posts?limit=20&cursor=abc  → page through posts
POST   /v1/posts               → create (returns 201 + Location header)
PATCH  /v1/posts/981           → edit
DELETE /v1/posts/981
\`\`\`

Good API habits:
- **Nouns, not verbs**: \`POST /orders\`, not \`/createOrder\`.
- **Pagination**: prefer **cursor-based** (\`?cursor=<opaque>\`) over offset (\`?page=500\`). Offsets get slow (the DB still scans skipped rows) and shift when new items arrive.
- **Versioning**: \`/v1/\` in the path or a header, so you can evolve without breaking clients.
- **Idempotency keys** for non-idempotent operations: \`Idempotency-Key: 7f3a…\` header on POST.
- **Consistent errors**: a machine-readable code plus a human message.
- **Rate limits** advertised in headers (\`Retry-After\`, \`X-RateLimit-Remaining\`).

### REST vs gRPC vs GraphQL
| | REST/JSON | gRPC | GraphQL |
|---|---|---|---|
| Best for | Public APIs, browsers | Internal service-to-service | Flexible client-driven reads |
| Format | Text JSON | Binary Protobuf, HTTP/2 | JSON, single endpoint |
| Strengths | Simple, cacheable, universal | Fast, typed, streaming | No over/under-fetching |
| Weaknesses | Chatty, loose typing | Not browser-native | Caching and cost control are hard |

> **Interview** When asked to "design the API", list 3–6 endpoints with method, path, key params and response. Mention pagination and idempotency unprompted; it signals experience.

## The lab: DNS failover

Two regions sit behind DNS. At 20 s, **us-west** goes dark. With a long TTL and no health checks, clients keep resolving to the dead region. You need DNS that notices quickly, and a surviving region big enough to take *all* the traffic.
`,
      quiz: [
        { q: 'Which request is safe to retry blindly after a timeout?', options: ['POST /payments', 'PUT /users/42/email with the full new value', 'POST /orders', 'POST /messages'], answer: 1, why: 'PUT is idempotent: applying the same full replacement twice leaves the same result. POSTs need an idempotency key before they are safe to retry.' },
        { q: 'Why is cursor pagination preferred over `?page=N` for large feeds?', options: ['Cursors are shorter strings', 'Offsets force the DB to scan and discard all skipped rows, and pages shift as new items arrive', 'Browsers cache cursors', 'REST forbids page numbers'], answer: 1, why: 'OFFSET 100000 still walks 100k rows; a cursor ("items after id X") uses the index to jump straight there and stays stable when new rows are inserted.' },
        { q: 'A failover DNS record has TTL 3600s. A region dies. Worst case, how long do some clients keep trying it?', options: ['Instantly redirected', 'Up to ~1 hour', 'Exactly 60 seconds', 'Until the user reloads'], answer: 1, why: 'Resolvers and clients cache the answer for the TTL. Failover records use short TTLs (30–60s) for exactly this reason.' },
      ],
      lab: {
        title: 'Survive a region outage',
        brief: `Traffic is split across **us-east** and **us-west** by DNS. At **20 s** us-west suffers a full outage.

Right now DNS has a **1-hour TTL** and **no health checks**, so half your users keep getting sent to a dead region. And even when DNS does fail over, can us-east carry *everything*?

Pass by keeping **availability ≥ 95% over the whole run** and p99 under 500 ms.`,
        duration: 90,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 1600, readRatio: 0.9 }],
          ['dns', 'dns', X(1), Y(1.5), { mode: 'round-robin', healthChecks: false, ttl: 3600 }],
          ['lbE', 'lb', X(2), Y(0.5), { region: 'us-east' }, 'LB us-east'],
          ['lbW', 'lb', X(2), Y(2.5), { region: 'us-west' }, 'LB us-west'],
          ['appE', 'app', X(3), Y(0.5), { instances: 2, region: 'us-east' }, 'App us-east'],
          ['appW', 'app', X(3), Y(2.5), { instances: 2, region: 'us-west' }, 'App us-west'],
          ['db', 'sqldb', X(4), Y(1.5), { size: 'M', region: 'us-east' }],
        ], ['u>dns', 'dns>lbE', 'dns>lbW', 'lbE>appE', 'lbW>appW', 'appE>db', 'appW>db']),
        events: [{ at: 20, do: 'region', region: 'us-west' }],
        goals: [
          { metric: 'availability', op: '>=', value: 0.95, label: 'Availability ≥ 95% over the run', at: 'end' },
          { metric: 'p99', op: '<', value: 500, label: 'p99 under 500 ms', after: 5 },
        ],
        hints: [
          'Select the DNS node. Turn on **health checks** and drop the **TTL** to a few seconds. Detection can be no faster than the TTL clients cache.',
          'After failover, us-east receives all 1,600 rps. Two S instances handle ~1,000. Give us-east enough instances (or autoscaling) to carry the full load: that is N+1 capacity planning.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 1600, readRatio: 0.9 }],
          ['dns', 'dns', X(1), Y(1.5), { mode: 'round-robin', healthChecks: true, ttl: 5 }],
          ['lbE', 'lb', X(2), Y(0.5), { region: 'us-east' }, 'LB us-east'],
          ['lbW', 'lb', X(2), Y(2.5), { region: 'us-west' }, 'LB us-west'],
          ['appE', 'app', X(3), Y(0.5), { instances: 5, region: 'us-east' }, 'App us-east'],
          ['appW', 'app', X(3), Y(2.5), { instances: 2, region: 'us-west' }, 'App us-west'],
          ['db', 'sqldb', X(4), Y(1.5), { size: 'M', region: 'us-east' }],
        ], ['u>dns', 'dns>lbE', 'dns>lbW', 'lbE>appE', 'lbW>appW', 'appE>db', 'appW>db']),
        debrief: 'Two lessons in one. **Failover speed is bounded by detection + TTL.** And **every region must be able to absorb the load of the region that fails** (N+1 capacity). Running two regions at 60% each means neither survives the other’s failure.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'latency-throughput',
      title: 'Latency vs. throughput',
      minutes: 25,
      summary: 'Latency is how long one request takes; throughput is how many you finish per second. They are linked by queueing, and that link explains almost every performance incident.',
      body: `
## Definitions

- **Latency**: time from sending a request to receiving the response. Measured in ms. Users feel it.
- **Throughput**: completed requests per unit time (requests/s, QPS, MB/s). Your bill and your capacity plan care about it.
- **Bandwidth** is the *maximum* throughput of a link; throughput is what you actually achieve.

A highway analogy: latency is how long one car takes to drive from A to B; throughput is how many cars pass B per hour. Adding lanes raises throughput without making any single car faster.

## Measure percentiles, not averages

Averages hide pain. If 99 requests take 10 ms and one takes 5 s, the average is 60 ms, which describes nobody's experience.

- **p50 (median)**: the typical request.
- **p99**: 1 in 100 requests is slower than this. With 100 backend calls per page load, *most* users hit at least one p99.
- **p99.9**: what your heaviest users (more requests → more chances) see constantly.

> **Key idea** Tail latency amplifies with fan-out. If a page calls 10 services in parallel, the page is as slow as the *slowest* of the 10. P(at least one call is above its p99) = 1 − 0.99¹⁰ ≈ 10%.

## Little's law

For any stable system:

\`\`\`
L = λ × W
in-flight requests = arrival rate × time each spends in the system
\`\`\`

If a server has **200 threads** and each request takes **100 ms**, max throughput is 200 / 0.1 s = **2,000 req/s**. If a dependency slows down to 1 s, the same 200 threads now only manage **200 req/s**, even though CPU is idle. This is *thread-pool exhaustion*, the most common way a slow database takes down an entire fleet. The simulator models it exactly this way.

## Queueing: why latency explodes near 100%

A server at utilization ρ (load ÷ capacity) has requests waiting their turn. For a simple queue, average time in system ≈ service time ÷ (1 − ρ):

| Utilization | Time vs. idle |
|---|---|
| 50% | 2× |
| 70% | 3.3× |
| 90% | 10× |
| 95% | 20× |
| >100% | grows forever (the queue never drains) |

That is the **knee of the curve**. Throughput rises almost linearly with load, but latency is flat… flat… then vertical. This is why well-run systems target **50–70% utilization**: headroom isn't waste; it's what keeps p99 sane and absorbs spikes.

Once load exceeds capacity, the queue grows without bound until something gives: timeouts, memory, or the load balancer. The fix is either **more capacity** or **less work** (caching, shedding, rate limiting).

## Latency numbers every engineer should know

| Operation | Time |
|---|---|
| L1 cache reference | 1 ns |
| Main memory reference | 100 ns |
| Compress 1 KB (Snappy) | 2 µs |
| Read 1 MB sequentially from memory | 3 µs |
| SSD random read | 16–100 µs |
| Round trip within a datacenter | 0.5 ms |
| Read 1 MB sequentially from SSD | ~50 µs–1 ms |
| Redis GET (same AZ) | 0.2–1 ms |
| Simple indexed DB query | 1–5 ms |
| Disk seek (HDD) | 2–10 ms |
| Round trip US East ↔ US West | ~65 ms |
| Round trip US ↔ Europe | ~80–100 ms |
| Round trip US ↔ Asia/Australia | ~150–250 ms |

Rules of thumb: memory is ~100× faster than SSD; a datacenter round trip is ~1,000× slower than memory; cross-continent round trips dominate everything else, so *move data close to users* (CDNs, regions).

## Trading one for the other

- **Batching** raises throughput (fewer round trips, better compression) but adds latency (wait to fill a batch). Kafka producers, DB bulk inserts.
- **Parallelism** cuts latency for fan-out work but costs throughput elsewhere.
- **Caching** improves both.
- **Async processing** (queues) gives the user a fast response by deferring work.

> **Interview** When you state a requirement, give both: "p99 < 200 ms at 50k RPS peak." A latency number without a load is meaningless.

## The lab

Traffic **ramps** from 250 to 2,500 rps. Watch the app tier's p99 as utilization crosses 70%: flat, then a cliff. Find a configuration that holds p99 under 250 ms through the whole ramp, without overspending.
`,
      quiz: [
        { q: 'A service has 100 worker threads. Average request takes 50 ms. What is its maximum throughput?', options: ['50 req/s', '500 req/s', '2,000 req/s', '5,000 req/s'], answer: 2, why: "Little's law: throughput = concurrency / time = 100 / 0.05 s = 2,000 req/s." },
        { q: 'Why do teams target ~60% utilization instead of 95%?', options: ['Cloud providers charge more above 60%', 'Queueing makes latency grow sharply as utilization approaches 100%, and you need headroom for spikes', 'CPUs overheat', 'It is a Kubernetes limit'], answer: 1, why: 'Waiting time scales roughly with 1/(1−ρ): 3× at 70%, 20× at 95%. Headroom buys predictable latency and spike absorption.' },
        { q: 'A page fans out to 20 backend calls in parallel. Each call has p99 = 100 ms. Roughly what fraction of page loads see at least one call ≥ 100 ms?', options: ['1%', '~18%', '50%', '99%'], answer: 1, why: '1 − 0.99²⁰ ≈ 18%. Tail latency compounds with fan-out, which is why p99 (or p99.9) of leaf services matters so much.' },
      ],
      lab: {
        title: 'Find the knee',
        brief: `A stateless image-resizing service. Traffic **ramps from 250 to 2,500 rps** over the run. Each request costs 20 ms of CPU.

With 3 small instances the service is fine at first, then falls off a cliff. Size the tier so that **p99 stays under 250 ms** for the whole ramp, while spending **less than $400/month**.

Watch the **CPU %** on the App Server and the p99 in the bottom bar as the ramp climbs.`,
        duration: 90,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 1000, pattern: 'ramp', readRatio: 1, retries: 0 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 3, size: 'S', baseMs: 20 }, 'Resizer'],
        ], ['u>lb', 'lb>app']),
        goals: [
          { metric: 'p99', op: '<', value: 250, label: 'p99 under 250 ms the whole time', after: 3 },
          { metric: 'errRate', op: '<', value: 0.005, label: 'Errors under 0.5%', after: 3 },
          { metric: 'cost', op: '<', value: 400, label: 'Cost under $400/month', after: 0 },
        ],
        hints: [
          'At 2,500 rps you need capacity well above 2,500 so utilization stays below ~70%. One S instance handles 500 rps.',
          '8 × S gives 4,000 rps of capacity (~62% at peak) for $320/month. 1 × XL also gives 4,000 but costs $400, and it is a single point of failure.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 1000, pattern: 'ramp', readRatio: 1, retries: 0 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 8, size: 'S', baseMs: 20 }, 'Resizer'],
        ], ['u>lb', 'lb>app']),
        debrief: 'Latency stayed nearly flat until ~70% utilization, then shot up. That is the queueing knee. Capacity planning means sizing for **peak load ÷ target utilization**, not for peak load.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'scaling',
      title: 'Horizontal vs. vertical scaling',
      minutes: 20,
      summary: 'Scale up by buying a bigger machine, or scale out by adding more machines. Learn when each is right, why autoscaling is not instant, and what makes a service scalable in the first place.',
      body: `
## Two directions

**Vertical scaling (scale up)**: move to a bigger box: more CPU, RAM, faster disks.
- ✅ Zero code changes; no distributed-systems problems; great for databases.
- ❌ Hard ceiling (the biggest instance), price grows faster than capacity at the top end, still a single point of failure, and resizing usually means a restart.

**Horizontal scaling (scale out)**: add more identical machines behind a load balancer.
- ✅ Near-linear capacity, no ceiling, redundancy for free (lose 1 of 10 → lose 10%), commodity pricing.
- ❌ Requires statelessness (or partitioned state), adds a load balancer, adds coordination problems for anything stateful.

In the simulator, an **XL** instance costs ~10× an **S** for 8× the capacity, and stops at 4,000 rps. Ten S instances cost $400 for 5,000 rps *and* survive a server dying.

## What makes a service horizontally scalable?

1. **No local state**: sessions in Redis or signed tokens (JWT), uploads in object storage, caches either shared or disposable.
2. **Idempotent, retry-safe handlers**: a request may land on any instance, possibly twice.
3. **No singleton work**: cron jobs and leaders need a lock or leader election, or they'll run N times.
4. **Externalized configuration**: every instance boots identically.

The data tier is where scaling gets hard. Databases scale up first (it is remarkably far: a modern 64-core box with NVMe handles tens of thousands of transactions/s), then out via **replicas** (reads) and **sharding** (writes). Weeks 3–4.

## Autoscaling

Autoscalers watch a metric (CPU, requests per instance, queue depth) and adjust instance count toward a **target** (e.g. 60% CPU).

The catch is **reaction time**. Detection takes ~1–3 min of metrics, booting a VM/container takes 30 s–5 min, warming JIT and caches takes longer. Autoscaling handles **gradual** change (daily cycles) well and **sudden** spikes badly. Strategies:

- **Keep headroom**: a lower target (50%) means more spare capacity while new instances boot.
- **Scheduled scaling**: pre-scale before known peaks (9 am, a product launch, a sale).
- **Fast boot**: slim images, pre-baked AMIs, warm pools.
- **Absorb the spike elsewhere**: queues, caches, rate limiting (later lessons).
- **Scale on leading indicators**: request rate or queue depth beats CPU, which lags.

Scale-in should be **slower** than scale-out to avoid flapping (add fast, remove slowly).

> **Numbers** Rough capacity of one well-written service instance: 1k–10k simple req/s for in-memory work; 100s req/s when each request does meaningful DB work. Always measure: load test, find the knee, divide by your target utilization.

## Diagonal scaling

Real systems do both: pick a sensible instance size (often mid-sized for best price/performance and fault isolation), then scale out. Databases go up first, then out.

> **Interview** Say "the app tier is stateless, so it scales horizontally behind a load balancer with autoscaling on CPU/RPS." Then move on: interviewers care about the *data* tier, because that is the hard part.

## The lab

Traffic follows a daily wave: it swings between **1,000 and 4,000 rps**, with a whole "day" compressed into 90 seconds. Provisioning for the peak around the clock is expensive, and a single big machine can't reach the peak at all. Use horizontal scaling with **autoscaling** to keep p99 healthy while keeping the **average** cost down.
`,
      quiz: [
        { q: 'Which is the strongest argument for horizontal over vertical scaling of a web tier?', options: ['It is always cheaper per CPU', 'It removes the single point of failure and has no hard capacity ceiling', 'It needs no load balancer', 'It makes each request faster'], answer: 1, why: 'Scale-out adds redundancy and keeps going past the biggest instance. Per-request speed is unchanged.' },
        { q: 'A flash sale will send 10× traffic at exactly 12:00. What helps most?', options: ['Autoscaling on CPU with default settings', 'Scheduled pre-scaling before 12:00, plus a queue or rate limiter for anything beyond', 'A bigger database', 'Lower the autoscaling target to 90%'], answer: 1, why: 'Reactive autoscaling lags minutes behind a step change. Known spikes call for scheduled scaling, with load shedding or queueing as a safety net.' },
      ],
      lab: {
        title: 'Ride the daily wave',
        brief: `Traffic follows a **diurnal** wave between ~1,000 and ~4,000 rps. A whole "day" is compressed into 90 seconds.

The starter fleet is sized for the peak around the clock: it's fast, but you pay for 14 servers at 3 am too. Turn on **autoscaling** (select **Web tier**) and tune it so that:
- p99 stays under **300 ms**,
- errors stay under **1%**,
- the **average** cost over the run is below **$440/month**.

Instances take **5 s to boot** (think ~5 minutes in real time), so the autoscaler is always a little behind the curve.`,
        duration: 120,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 2500, pattern: 'diurnal', readRatio: 1, retries: 0 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 14, size: 'S', baseMs: 20, bootSec: 5, minInstances: 2, maxInstances: 20, targetCpu: 70 }, 'Web tier'],
        ], ['u>lb', 'lb>app']),
        goals: [
          { metric: 'p99', op: '<', value: 300, label: 'p99 under 300 ms', after: 5 },
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 5 },
          { metric: 'avgCost', op: '<', value: 440, label: 'Average cost under $440/month', at: 'end' },
        ],
        hints: [
          'Select **Web tier** and enable **Autoscaling**. A static fleet that survives the peak costs too much on average.',
          'A 70% target leaves almost no room while new instances boot, so p99 spikes on every upswing. Around **50–55%** keeps headroom.',
          'Min instances matters too: if the floor is too low, the first climb out of the trough overwhelms the fleet before the autoscaler catches up. Try **5**.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 2500, pattern: 'diurnal', readRatio: 1, retries: 0 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 5, size: 'S', baseMs: 20, autoscale: true, bootSec: 5, minInstances: 5, maxInstances: 20, targetCpu: 50 }, 'Web tier'],
        ], ['u>lb', 'lb>app']),
        debrief: 'Autoscaling turns a fixed cost into a variable one, but only if it can **keep ahead** of demand. Boot time, target utilization and the minimum fleet all trade off: slower boots need more headroom. Try raising Boot time to 15 s and watch the same settings fall over.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'estimation',
      title: 'Back-of-the-envelope estimation',
      minutes: 20,
      summary: 'Turn vague requirements into numbers in two minutes: QPS, storage, bandwidth, servers. These estimates drive every architectural choice that follows.',
      calculator: { dau: 50000000, readsPerUser: 40, writesPerUser: 1, recordKB: 1, peak: 3, years: 5, replication: 3, serverRps: 1000 },
      body: `
## Why estimate?

The architecture for 100 QPS and 1M QPS are different systems. Estimation tells you **which problems you actually have**: is storage the challenge, or reads, or writes, or bandwidth? Interviewers use it to see whether your design choices are grounded.

## The handful of numbers to memorize

- **1 day ≈ 86,400 s ≈ 10⁵ s** (round it).
- 1 million requests/day ≈ **12 req/s**. 1 billion/day ≈ **12k req/s**.
- **Peak ≈ 2–5× average** (diurnal cycles, events).
- Powers of two: 2¹⁰ ≈ 1 thousand (KB), 2²⁰ ≈ 1 million (MB), 2³⁰ ≈ 1 billion (GB), 2⁴⁰ ≈ 1 trillion (TB).
- A char ≈ 1 byte (ASCII) / 2–4 bytes (Unicode); a UUID 16 bytes; a timestamp 8 bytes; a typical row with metadata ~0.5–1 KB.
- A photo ≈ 200 KB–2 MB; 1 minute of 720p video ≈ 50 MB (multiple encodings ×3–5).
- One app server: ~1k req/s of real work (very rough). One Postgres box: ~10k simple queries/s, a few thousand writes/s. One Redis node: ~100k ops/s. One Kafka partition: ~5–10 MB/s.

## The method

1. **Users**: DAU (daily active users), and how many actions each does per day.
2. **QPS**: DAU × actions/day ÷ 10⁵. Split **reads vs writes**; the ratio shapes the design (read-heavy → caching/replicas; write-heavy → partitioning/queues).
3. **Peak**: × 2–5.
4. **Storage**: writes/day × size × retention × replication.
5. **Bandwidth**: QPS × response size (egress usually dominates for media).
6. **Memory for cache**: the 80/20 rule: cache the hottest ~20% of a day's reads.
7. **Servers**: peak QPS ÷ per-server capacity, plus headroom.

### Worked example: a Twitter-like feed
- 200M DAU, each views the timeline 10×/day and posts 0.5 tweets/day.
- Reads: 200M × 10 / 10⁵ = **20k QPS** average, **~60k peak**.
- Writes: 200M × 0.5 / 10⁵ = **1k QPS** average, ~3k peak. Read:write = 20:1 → read-optimized design (precomputed timelines, heavy caching).
- Storage: 100M tweets/day × ~300 bytes ≈ **30 GB/day** text → ~11 TB/year, ×3 replication ≈ 33 TB/yr. Media is far bigger and goes to object storage + CDN.
- Cache: 20% of the day's timeline reads … mostly fits in a Redis cluster of tens of nodes.

> **Interview** Say your assumptions out loud, round hard ("call it 10⁵ seconds"), and write results on the board. Precision doesn't matter. Orders of magnitude and the read:write ratio do. Spend ≤ 5 minutes.

> **Pitfall** Forgetting replication (×3) and indexes/overhead (×1.5–2) in storage; forgetting peak factor in QPS; confusing bits and bytes in bandwidth (network links are quoted in **bits**/s).

## The lab

Use the calculator below with: **50M DAU, 40 reads and 1 write per user per day, peak 3×**. It gives you a peak load. The lab sends you exactly that load (rounded to **~70,000 rps**, 97.5% reads). Size every tier: load balancers, app servers, cache and database. The starter design is sized for 1/10th of that.
`,
      quiz: [
        { q: '10M DAU, each making 30 requests/day. Average QPS?', options: ['~300', '~3,000', '~30,000', '~300,000'], answer: 1, why: '10⁷ × 30 / 10⁵ = 3,000 QPS average (peak maybe 6–15k).' },
        { q: '100M photos uploaded per day at 500 KB, stored for 5 years with 3 replicas. Storage?', options: ['~90 TB', '~900 TB', '~270 PB', '~270 TB'], answer: 2, why: '100M × 0.5 MB = 50 TB/day → ×365×5 ≈ 91 PB → ×3 ≈ 270 PB. This is why media goes to object storage with erasure coding, not databases.' },
      ],
      lab: {
        title: 'Size it for real',
        brief: `Peak load from the estimate: **~70,000 rps** (97.5% reads). The starter architecture handles about a tenth of that.

Size every tier so the system holds **p99 under 300 ms** and **errors under 1%**, for **less than $15,000/month**.

Things to check: how many requests can one load balancer instance take? How many app servers do you need at ~60% utilization? What fraction of reads must the cache absorb so the database survives?`,
        duration: 45,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 70000, readRatio: 0.975, workingSetGB: 40 }],
          ['lb', 'lb', X(1), Y(1), { instances: 1 }],
          ['app', 'app', X(2), Y(1), { instances: 8, size: 'M' }],
          ['cache', 'cache', X(3), Y(0.3), { memoryGB: 8, nodes: 1 }],
          ['db', 'sqldb', X(3), Y(1.7), { size: 'M' }],
        ], ['u>lb', 'lb>app', 'app>cache', 'app>db', 'cache>db']),
        goals: [
          { metric: 'p99', op: '<', value: 300, label: 'p99 under 300 ms', after: 6 },
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 6 },
          { metric: 'cost', op: '<', value: 15000, label: 'Cost under $15k/month', after: 0 },
        ],
        hints: [
          'One LB instance handles ~20k rps, so you need at least 4. App servers: 70k ÷ (1,000 rps per M × ~0.65 target) ≈ 108 M instances. Compare sizes on **rps per dollar**: S = 12.5, M = 11.8, XL = 10.',
          'Writes: ~1,750/s × 4 work units ≈ 7,000 units/s. Only an **XL** primary (12k) has room for that plus cache misses.',
          'Reads: the hot set is 40 GB. A cache with ~3 × 32 GB of memory hits ~98%, so the database only sees the misses.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 70000, readRatio: 0.975, workingSetGB: 40 }],
          ['lb', 'lb', X(1), Y(1), { instances: 5 }],
          ['app', 'app', X(2), Y(1), { instances: 110, size: 'M' }],
          ['cache', 'cache', X(3), Y(0.3), { memoryGB: 32, nodes: 3 }],
          ['db', 'sqldb', X(3), Y(1.7), { size: 'XL' }],
        ], ['u>lb', 'lb>app', 'app>cache', 'app>db', 'cache>db']),
        debrief: 'Every tier had a different limit: LBs by connection throughput, apps by CPU, the cache by memory vs. hot-set size, the database by **write throughput of a single primary**. The primary is the one you can’t just multiply, and that drives the next module: scaling the data tier.',
      },
    },
  ],
};
