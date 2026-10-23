import { G, X, Y } from './util.js';

export default {
  week: '7–8',
  title: 'Distributed Systems',
  lessons: [
    // ------------------------------------------------------------------
    {
      id: 'cap',
      title: 'CAP theorem & PACELC',
      minutes: 25,
      summary: 'When the network splits, a distributed database must choose: refuse requests to stay correct, or answer and risk being stale. CAP names that trade-off; PACELC adds the one you pay every day.',
      body: `
## The statement

In a distributed data store, when a **network partition (P)** occurs, you must choose between:
- **Consistency (C)**: every read returns the most recent write (formally *linearizability*: the system behaves like a single copy), or an error.
- **Availability (A)**: every request to a non-failed node gets a (non-error) response, possibly stale.

You cannot have both *during a partition*. Since networks **do** partition (switch failures, misconfigured firewalls, cross-region link cuts, GC pauses that look like partitions), "CA" is not a real option for a distributed system. The real choice is **CP or AP when partitioned**.

> **Key idea** CAP is not "pick two of three". It is: **when** the network partitions, do you sacrifice consistency or availability? When there is no partition, you can have both.

## CP systems
Refuse (or block) requests that can't be confirmed by a majority/quorum. The minority side of a partition becomes unavailable.
- Examples: ZooKeeper, etcd, Consul (Raft/Paxos-based), HBase, Spanner, MongoDB with majority writes, Cassandra at QUORUM/ALL.
- Use for: leader election, locks, configuration, **money**, inventory, uniqueness (usernames).

## AP systems
Keep answering on both sides; reconcile when the partition heals (last-write-wins, merges, CRDTs).
- Examples: Cassandra/Dynamo at consistency ONE, DNS, Couchbase/Riak configurations, most caches.
- Use for: shopping carts (Amazon's original Dynamo motivation: never refuse an "add to cart"), social feeds, likes, presence, metrics.

## PACELC: the everyday trade-off

CAP only talks about partitions, which are rare. **PACELC** says: if **P**artitioned, choose **A** or **C**; **E**lse (normal operation), choose **L**atency or **C**onsistency.

Even with a healthy network, strong consistency costs **coordination**: waiting for a quorum or a leader, sometimes across regions. That is latency you pay on every request.

| System | P → | E → |
|---|---|---|
| DynamoDB (default), Cassandra (ONE) | A | L |
| Cassandra (QUORUM) | C | C |
| Spanner, CockroachDB | C | C |
| MongoDB (majority) | C | C |
| PNUTS (Yahoo) | C | L |

## Consistency is a spectrum

From strongest to weakest:
1. **Linearizable**: real-time order; one-copy illusion.
2. **Sequential**: everyone sees the same order, not necessarily real-time.
3. **Causal**: cause before effect (a reply after its question) for everyone.
4. **Session guarantees**: read-your-writes, monotonic reads.
5. **Eventual**: replicas converge "eventually" if writes stop.

Many products need only causal + session guarantees, which are achievable while staying available.

## Tunable consistency

Leaderless stores let you choose per request. With **N** replicas, **W** acks per write, **R** replicas per read:
- \`R + W > N\` → reads overlap the latest write (strong-ish; QUORUM/QUORUM with N=3 → 2+2 > 3).
- \`W = 1, R = 1\` → fastest, most available, possibly stale.
- \`W = N\` (ALL) → any one replica down blocks writes.

> **Interview** Don't recite CAP. Apply it: "For the cart we choose AP: during a partition both sides accept writes and we merge carts on heal. For payments we choose CP: we'd rather return an error than double-spend." Then mention latency (PACELC).

## The lab

A shopping-cart service on a 6-node Cassandra cluster. At **20 s** a network partition cuts off a third of the nodes for 30 s. The business rule: **adding to cart must never fail**. Some temporary staleness is acceptable.
`,
      quiz: [
        { q: 'Why is "CA" (consistent + available, no partition tolerance) not a meaningful choice for a multi-node database?', options: ['It is too expensive', 'Partitions happen whether you design for them or not; the only question is how you behave when they do', 'CA systems are illegal', 'Partition tolerance is optional on cloud providers'], answer: 1, why: 'You cannot opt out of network failures. A single-node database is "CA" only because it isn’t distributed.' },
        { q: 'Which system should choose CP?', options: ['A news feed', 'A like counter', 'A distributed lock service used for leader election', 'A product recommendations cache'], answer: 2, why: 'Two leaders (split brain) is a correctness disaster. Lock/election services must refuse rather than give a wrong answer.' },
        { q: 'N=5 replicas. You want writes to survive 2 replica failures and reads to always see the latest write. Which (W, R)?', options: ['W=1, R=5', 'W=3, R=3', 'W=5, R=1', 'W=2, R=2'], answer: 1, why: 'W=3 tolerates 2 failures for writes; R=3 with W=3 gives 3+3 > 5 overlap.' },
      ],
      lab: {
        title: 'Never lose an add-to-cart',
        brief: `A cart service on **NoSQL (Cassandra)**, 6 nodes, RF 3, currently at consistency **ALL**.

At **20 s** a network partition isolates a third of the cluster until **50 s**.

Business requirement: availability ≥ **99.5%** over the run (cart writes must keep working). Staleness is tolerable: keep stale reads under **35%** even during the partition. Latency matters too: p99 under 300 ms.`,
        duration: 70,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 3000, readRatio: 0.6, rttMs: 60 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 10 }, 'Cart service'],
          ['db', 'nosql', X(3), Y(1), { nodes: 6, rf: 3, consistency: 'ALL' }, 'Carts (Cassandra)'],
        ], ['u>lb', 'lb>app', 'app>db']),
        events: [{ at: 20, do: 'partition', target: 'db' }, { at: 50, do: 'heal' }],
        goals: [
          { metric: 'availability', op: '>=', value: 0.995, label: 'Availability ≥ 99.5%', at: 'end' },
          { metric: 'staleRate', op: '<', value: 0.35, label: 'Stale reads under 35%', after: 5 },
          { metric: 'p99', op: '<', value: 300, label: 'p99 under 300 ms', after: 5 },
        ],
        hints: [
          'ALL needs every replica, so any partition makes requests fail. QUORUM still fails for requests on the minority side.',
          'Choose availability: consistency level **ONE** keeps both sides of the partition answering (AP), at the cost of temporarily stale reads. That is exactly the Dynamo shopping-cart trade-off.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 3000, readRatio: 0.6, rttMs: 60 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 10 }, 'Cart service'],
          ['db', 'nosql', X(3), Y(1), { nodes: 6, rf: 3, consistency: 'ONE' }, 'Carts (Cassandra)'],
        ], ['u>lb', 'lb>app', 'app>db']),
        debrief: 'You chose **AP**: during the partition both sides kept accepting cart writes and some reads were stale; after healing, replicas reconcile. For a bank ledger you would choose the opposite and accept errors. Try QUORUM: errors appear only during the partition, and staleness vanishes.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'kafka',
      title: 'Kafka & message queues',
      minutes: 35,
      summary: 'Queues decouple producers from consumers in time. They absorb spikes, isolate failures and enable fan-out. Kafka adds a durable, replayable, partitioned log on top of that idea.',
      body: `
## Why put a queue in the middle?

Synchronous call chains couple everything: if the downstream is slow or down, the caller is slow or down. A queue lets the producer **hand off** work and return immediately:

- **Spike absorption (load leveling)**: a 4× burst fills the queue; consumers drain it at their own steady rate. The database never sees the spike.
- **Failure isolation**: if consumers are down, messages wait instead of being lost.
- **Fan-out**: one event, many independent consumers (email, analytics, search indexing).
- **Async UX**: "Your video is processing…" instead of a 3-minute HTTP request.

The cost: **eventual completion** (work happens later), **at-least-once** delivery to handle, ordering subtleties, and a new piece of infrastructure to operate.

## Queue vs. log

| | Traditional queue (RabbitMQ, SQS) | Log (Kafka, Kinesis, Pulsar) |
|---|---|---|
| Consumption | Message deleted after ack | Messages retained; consumers track an **offset** |
| Replay | No | Yes (rewind the offset) |
| Multiple consumers | Competing consumers on one queue; fan-out via exchanges/topics | Many **consumer groups**, each reading everything independently |
| Ordering | Best effort / FIFO queues | Strict **per partition** |
| Sweet spot | Task queues, RPC-ish work | Event streams, high throughput, multiple subscribers |

## Kafka architecture

- A **topic** is split into **partitions**: ordered, append-only logs, spread across **brokers**.
- Producers choose a partition by **key** (\`hash(key) mod P\`): all events for one key (one user, one order) land in one partition, **in order**.
- Each partition is replicated (RF 3 typical); a leader handles reads/writes, followers stay **in sync (ISR)**. \`acks=all\` waits for all in-sync replicas: durable but slower.
- A **consumer group** shares the work: each partition is assigned to **exactly one** consumer in the group. So **max parallelism = number of partitions**. A 6-partition topic can keep at most 6 consumers busy; a 7th sits idle.
- Different groups (billing, analytics, search) each get **every** message: pub/sub.
- Throughput: ~5–10 MB/s per partition; clusters do millions of messages/s.

> **Key idea** Partitions are Kafka's unit of parallelism **and** ordering. More partitions → more consumers; ordering holds only within a partition, so choose the key that must stay ordered.

## Delivery semantics

- **At-most-once**: commit offset before processing; a crash loses the message.
- **At-least-once**: process, then commit; a crash causes **redelivery**, so consumers must be **idempotent**. The usual choice.
- **Exactly-once**: Kafka transactions + idempotent producers within Kafka; end-to-end it really means *effectively once* = at-least-once + idempotent side effects (dedupe by message ID).

## Operational realities

- **Consumer lag** (how far behind consumers are) is the key health metric. Growing lag = consumers can't keep up.
- **Poison messages** that always fail block a partition. After N retries send them to a **dead-letter queue (DLQ)**.
- **Backpressure**: if the queue fills (retention/size limits), producers must slow down or fail.
- **Rebalancing** pauses a group when consumers join/leave.
- **Ordering + retries** conflict: retrying message 5 after processing 6 breaks order.

> **Interview** When you add a queue, state: the topic and **partition key** (and why: ordering per X), the number of partitions (≥ max consumers you'll need), delivery semantics (at-least-once + idempotent consumer), what happens on consumer failure (retry, DLQ), and how you monitor lag.

## The lab

An order API writes directly to the database. Traffic is **spiky**: 4× bursts every 30 s. The DB handles the average but not the spikes. Put a queue between the API and the database, and size the consumers. Remember the partition rule.
`,
      quiz: [
        { q: 'A topic has 8 partitions. You run 12 consumers in one consumer group. How many actively consume?', options: ['12', '8', '4', '1'], answer: 1, why: 'Each partition goes to exactly one consumer in the group, so 4 sit idle. Add partitions to scale further.' },
        { q: 'All events for one bank account must be processed in order. What should the partition key be?', options: ['A random UUID', 'The event timestamp', 'account_id', 'The consumer ID'], answer: 2, why: 'Same key → same partition → strict order for that account, while different accounts spread across partitions.' },
        { q: 'Consumers process a message, then crash before committing the offset. What happens?', options: ['The message is lost', 'The message is redelivered, so consumers must be idempotent', 'Kafka deletes the partition', 'The producer resends automatically'], answer: 1, why: 'That is at-least-once delivery. Handle duplicates with idempotency (dedupe by message ID, upserts).' },
      ],
      lab: {
        title: 'Level the spikes',
        brief: `Orders arrive in **spikes**: ~1,000 writes/s normally, **4,000/s** in 8-second bursts every 30 s. The API writes straight to an XL primary, which can take ~2,500 writes/s.

Insert a **Queue (Kafka)** between the API and the database, with **Workers** draining it into the DB (API → Queue → Worker → SQL Primary).

Goals: API errors under **0.5%**, API p99 under **250 ms**, consumer lag under **15 s**, cost under $3,500/month.`,
        duration: 90,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 1300, readRatio: 0.25, pattern: 'spiky', rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 16 }, 'Orders API'],
          ['db', 'sqldb', X(4), Y(1), { size: 'XL' }],
        ], ['u>lb', 'lb>app', 'app>db']),
        goals: [
          { metric: 'errRate', op: '<', value: 0.005, label: 'API errors under 0.5%', after: 5 },
          { metric: 'p99', op: '<', value: 250, label: 'API p99 under 250 ms', after: 5 },
          { metric: 'consumerLag', op: '<', value: 15, label: 'Consumer lag under 15 s', after: 5 },
          { metric: 'cost', op: '<', value: 3500, label: 'Cost under $3,500/month', after: 0 },
        ],
        hints: [
          'Add a Queue and a Worker. Wire Orders API → Queue → Worker → SQL Primary. Keep Orders API → SQL Primary for reads. Writes automatically prefer the queue.',
          'Workers must drain faster than the average write rate (~1,800/s over a cycle) but leave the DB headroom for the API’s reads. Each worker write costs 4 units on a 12k-unit XL: ~2,000 writes/s, i.e. **4 S workers**, keeps the DB near 80%.',
          'Consumers beyond the partition count sit idle. Make sure partitions ≥ worker instances.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 1300, readRatio: 0.25, pattern: 'spiky', rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 16 }, 'Orders API'],
          ['q', 'queue', X(3), Y(0), { partitions: 8 }],
          ['wk', 'worker', X(4), Y(0), { instances: 4 }],
          ['db', 'sqldb', X(5), Y(1), { size: 'XL' }],
        ], ['u>lb', 'lb>app', 'app>q', 'q>wk', 'wk>db', 'app>db']),
        debrief: 'The queue turned the spike into a short backlog that workers drained between bursts. The API stayed fast because it only had to append to a log. You traded **latency of completion** (a few seconds of consumer lag) for **availability and smoothness**. That trade is right for orders, emails and indexing, and wrong for anything the user must see immediately.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'eventual-consistency',
      title: 'Eventual consistency',
      minutes: 30,
      summary: 'Replicas that converge "eventually" are fast and available, and they confuse users in very specific ways. Learn the anomalies, the session guarantees that fix most of them, and how conflicts get resolved.',
      body: `
## What it promises (and doesn't)

**Eventual consistency**: if no new writes arrive, all replicas will eventually return the same value. It says nothing about *when*, or what you see in the meantime. In practice convergence takes milliseconds, until a replica lags, a partition happens, or a region falls behind.

## The anomalies users notice

1. **Read-your-writes violation**: "I changed my name, refreshed, and it's back to the old one."
2. **Monotonic reads violation**: refreshing alternates between new and old data (requests hit different replicas).
3. **Consistent prefix violation**: seeing an answer before its question in a comment thread.
4. **Lost update under concurrency**: two devices edit the same doc; one silently overwrites the other.

## Session guarantees (cheap, high-value)

You rarely need global linearizability. You usually need these, **per user session**:

- **Read-your-writes**: after a user writes, route *their* reads to the leader for a few seconds, or to a replica known to have caught up past the write's log position (pass the LSN/version token with the session).
- **Monotonic reads**: pin each user to one replica (hash user ID → replica), so time never goes backwards for them.
- **Writes-follow-reads / causal consistency**: carry dependency metadata so a reply is never visible before what it replies to.

## Conflict resolution (multi-leader / leaderless)

When two replicas accept different writes to the same key:
- **Last-write-wins (LWW)**: keep the one with the highest timestamp. Simple; **silently drops** data, and clock skew makes "last" arbitrary. Fine for idempotent overwrites (a profile photo), bad for counters or carts.
- **Version vectors / vector clocks**: detect that two writes were *concurrent* (neither saw the other) and keep both as **siblings** for the application to merge.
- **CRDTs** (conflict-free replicated data types): data structures whose merges always converge: grow-only counters, PN-counters, OR-sets, sequence CRDTs for collaborative text. Used in Riak, Redis Enterprise, Figma/Automerge-style collaboration.
- **Application merge**: union of cart items, then let the user fix it.

## Repair mechanisms

- **Read repair**: a read that sees divergent replicas writes back the newest value.
- **Anti-entropy**: background comparison using **Merkle trees** to find and sync differing ranges cheaply.
- **Hinted handoff**: when a replica is down, another node keeps "hints" and replays them later.

## Quorums revisited

N replicas, W write acks, R read replicas. \`R + W > N\` gives overlap, but even quorums have edge cases (sloppy quorums during failures, concurrent writes, LWW clocks). "Strong" in a leaderless system is weaker than linearizable unless you add more machinery.

> **Key idea** Most "eventual consistency bugs" are really missing **session guarantees**. Give each user read-your-writes and monotonic reads, and eventual consistency becomes invisible for most products.

> **Interview** When you put replicas or caches in front of reads, volunteer the anomaly and the fix: "a user editing their profile reads from the primary for 10 seconds after a write; everyone else reads from replicas."

## The lab

A profile service reads from small replicas while users frequently edit their profiles (25% writes). The replicas can't keep up with replaying writes, lag grows, and users don't see their own edits. Fix the lag **and** guarantee read-your-writes.
`,
      quiz: [
        { q: 'A user updates their bio and immediately sees the old one. Best targeted fix?', options: ['Make all reads go to the primary', 'Read-your-writes: route that user’s reads to the primary (or an up-to-date replica) briefly after their write', 'Increase cache TTL', 'Switch to last-write-wins'], answer: 1, why: 'Routing everything to the primary throws away read scaling. Only the writer needs fresh data, right after writing.' },
        { q: 'Two offline phones add different items to the same shopping cart. With last-write-wins on sync, what happens?', options: ['Both items are kept', 'One phone’s additions are silently lost', 'The sync fails', 'Duplicates are created'], answer: 1, why: 'LWW keeps one version and discards the other. A set CRDT or union-merge would keep both.' },
      ],
      lab: {
        title: 'See your own edits',
        brief: `A profile service with **25% writes**. Reads go to two **S-size** read replicas.

Replicas must replay every write, and these are too small to keep up: **replication lag** grows, and users see stale profiles.

Goals: stale reads under **1%**, p99 under 300 ms, errors under 1%, cost under $1,600/month.`,
        duration: 60,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 2400, readRatio: 0.75, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 8 }, 'Profile service'],
          ['db', 'sqldb', X(3), Y(0), { size: 'L' }],
          ['r1', 'replica', X(4), Y(0.8), { size: 'S' }, 'Replica 1'],
          ['r2', 'replica', X(4), Y(1.8), { size: 'S' }, 'Replica 2'],
        ], ['u>lb', 'lb>app', 'app>db', 'app>r1', 'app>r2', 'db>r1', 'db>r2']),
        goals: [
          { metric: 'staleRate', op: '<', value: 0.01, label: 'Stale reads under 1%', after: 8 },
          { metric: 'p99', op: '<', value: 300, label: 'p99 under 300 ms', after: 8 },
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 8 },
          { metric: 'cost', op: '<', value: 1600, label: 'Cost under $1,600/month', after: 0 },
        ],
        hints: [
          'Inspect a replica: replication apply (600 writes × 2) plus its share of reads exceeds an S instance (1,500 units), so lag grows forever. Bigger replicas (M) catch up.',
          'Even with healthy lag, some reads right after a write still hit a replica that hasn’t applied it yet. Turn on **Read-your-writes routing** on the Profile service.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 2400, readRatio: 0.75, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 8, readYourWrites: true }, 'Profile service'],
          ['db', 'sqldb', X(3), Y(0), { size: 'L' }],
          ['r1', 'replica', X(4), Y(0.8), { size: 'M' }, 'Replica 1'],
          ['r2', 'replica', X(4), Y(1.8), { size: 'M' }, 'Replica 2'],
        ], ['u>lb', 'lb>app', 'app>db', 'app>r1', 'app>r2', 'db>r1', 'db>r2']),
        debrief: 'Two separate problems looked the same to users: **lag** (replicas too small to replay the write stream) and **read-your-writes** (even milliseconds of lag matter to the person who just wrote). Fix capacity for the first, a session guarantee for the second.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'resilience',
      title: 'Retries, idempotency & circuit breakers',
      minutes: 35,
      summary: 'Remote calls fail and hang. Timeouts bound the damage, retries recover transient errors, idempotency makes retries safe, and circuit breakers stop a sick dependency from taking everyone down with it.',
      body: `
## The failure modes of a remote call

A call can: succeed; fail fast (connection refused, 503); **hang** (no response, the most dangerous); succeed but the response is lost (you **don't know** whether it happened); or return garbage. Your code must handle all of them.

## Timeouts: the first defense

**Every** network call needs a timeout. Without one, a hung dependency holds your thread/connection forever. By Little's law, your capacity collapses to \`threads / hang_time\` and you go down **even though your CPU is idle**: **thread-pool exhaustion**, the classic cascading failure.

Setting them:
- Base on the dependency's real latency: e.g. a bit above its **p99.9**, not "30 seconds because that's the default".
- Use **deadlines** that propagate: if the user request has 800 ms left, don't give a downstream call 2 s.
- Connection timeouts short (≈ 100s of ms); request timeouts per operation.

## Retries: recover from transient failures

Many failures are transient (a dropped packet, a restarting pod). A retry often succeeds. But naive retries are dangerous:

- **Retry storms**: a struggling service gets 3× the traffic from retries exactly when it can least handle it. With retries at *every* layer of a 4-deep call chain (3 attempts each), one user request can become **3⁴ = 81** calls at the bottom.
- **Synchronized retries** from thousands of clients hit at the same instant.

Do it right:
- **Exponential backoff with jitter**: \`sleep = random(0, min(cap, base × 2^attempt))\` ("full jitter").
- **Retry budgets**: retries may be at most ~10% of requests; beyond that, stop retrying.
- **Retry only retryable errors**: timeouts, 503, 429 (honor \`Retry-After\`). Never 400s.
- **Retry at one layer** (usually the edge or the immediate caller), not all of them.
- **Only retry idempotent operations**, or make them idempotent ↓

## Idempotency: making retries safe

An operation is idempotent if doing it twice equals doing it once. GET/PUT/DELETE are naturally idempotent; "charge $50" is not. If the response to \`POST /charges\` is lost, the client can't know whether the charge happened, and a retry might **charge twice**.

**Idempotency keys** (Stripe's design): the client generates a unique key per logical operation and sends it with every attempt:

\`\`\`
POST /v1/charges
Idempotency-Key: 4f9d0e2a-...      ← same key on every retry
\`\`\`
Server: in the same transaction as the side effect, insert the key into a table with a **unique constraint**, and store the response. A retry with a seen key returns the stored response instead of charging again. Keys expire after ~24 h.

Same idea for consumers: at-least-once delivery + dedupe by message ID = **effectively-once** processing.

## Circuit breakers: stop hammering a sick dependency

Like an electrical breaker:
- **Closed**: calls flow; track failures.
- **Open**: failure rate crossed a threshold, so **fail immediately** without calling (no waiting, no load on the dependency). It gets room to recover, and you keep your threads.
- **Half-open**: after a cool-down, let a few probe calls through; success → close, failure → open again.

Pair with a **fallback**: cached data, a default ("recommendations unavailable"), a degraded feature. A product page without reviews beats an error page.

## Bulkheads

Isolate resources per dependency (separate thread pools/connection pools), so a slow recommendations service can only exhaust *its* pool, not the one checkout needs. Named after ship compartments.

> **Key idea** Timeouts bound waiting. Retries (with backoff, budgets and idempotency) recover blips. Circuit breakers and bulkheads contain persistent failures. Fallbacks turn failures into degradation.

> **Interview** For any call to a third party (payments, SMS, maps), say: timeout, bounded retries with jittered backoff, idempotency key, circuit breaker with fallback, and how you reconcile "unknown" outcomes (query status later, webhooks).

## The lab

A product API calls a **reviews** service. At **15 s** the reviews service becomes 10× slower for 30 s. The API has no timeout, so its threads pile up waiting, and clients retry aggressively. Watch the whole API go down for a non-critical feature, then fix it.
`,
      quiz: [
        { q: 'A service has 200 threads. A dependency normally answers in 20 ms but starts hanging for 10 s. With no timeout, roughly what throughput can the service sustain?', options: ['Unchanged (10,000 req/s)', '~20 req/s', '~200 req/s', '0'], answer: 1, why: "Little's law: 200 threads / 10 s ≈ 20 req/s. A timeout of 200 ms would keep it around 1,000 req/s." },
        { q: 'Which retry policy is best for a call to a struggling service?', options: ['Retry immediately up to 5 times', 'Exponential backoff with jitter, a small retry budget, only for retryable errors', 'Retry forever until it works', 'Never retry anything'], answer: 1, why: 'Backoff and jitter spread retries out; budgets cap amplification; and only transient errors are worth retrying.' },
        { q: 'A payment request times out at the client. What makes a retry safe?', options: ['Waiting 10 seconds first', 'Sending the same idempotency key so the server returns the original result if it already processed it', 'Using PUT instead of POST', 'Retrying from a different region'], answer: 1, why: 'The server dedupes on the key and returns the stored response, so there is no double charge.' },
      ],
      lab: {
        title: 'Contain the blast radius',
        brief: `The **Product API** calls a **Reviews** service on every request. At **15 s** Reviews becomes **10× slower** (until 45 s).

The API has **no timeout** and no circuit breaker; clients retry twice without backoff. Watch the thread pools drain and the whole API fail for a non-critical feature.

Goals: availability ≥ **97%** over the run, and p99 back under **600 ms** by the end. Serving pages *without reviews* (a fallback) counts as success. Select **Product API** for the resilience settings.`,
        duration: 70,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 2000, readRatio: 0.95, retries: 2, backoff: false, timeoutMs: 3000, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 6, size: 'S', timeoutMs: 0, retries: 0 }, 'Product API'],
          ['rev', 'app', X(3), Y(0.2), { instances: 6, size: 'S', baseMs: 30 }, 'Reviews'],
          ['db', 'sqldb', X(3), Y(1.8), { size: 'M' }, 'Products DB'],
        ], ['u>lb', 'lb>app', 'app>rev', 'app>db']),
        events: [{ at: 15, do: 'slow', target: 'rev' }, { at: 45, do: 'unslow', target: 'rev' }],
        goals: [
          { metric: 'availability', op: '>=', value: 0.97, label: 'Availability ≥ 97%', at: 'end' },
          { metric: 'p99', op: '<', value: 600, label: 'p99 under 600 ms at the end', at: 'end' },
        ],
        hints: [
          'Select **Product API** and set a **downstream timeout**: something like 150–300 ms (Reviews normally answers in ~50 ms).',
          'A timeout alone turns slowness into errors. Turn on the **Circuit breaker** with **Fallback**, so while Reviews is sick the API serves products without reviews instead of failing.',
          'Select **Users** and turn on **exponential backoff** so client retries don’t pile on.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 2000, readRatio: 0.95, retries: 2, backoff: true, timeoutMs: 3000, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 6, size: 'S', timeoutMs: 200, retries: 0, circuitBreaker: true, fallback: true }, 'Product API'],
          ['rev', 'app', X(3), Y(0.2), { instances: 6, size: 'S', baseMs: 30 }, 'Reviews'],
          ['db', 'sqldb', X(3), Y(1.8), { size: 'M' }, 'Products DB'],
        ], ['u>lb', 'lb>app', 'app>rev', 'app>db']),
        debrief: 'Without a timeout, a non-critical dependency took down the whole product page (thread-pool exhaustion), and client retries made it worse. Timeout + circuit breaker + fallback turned an outage into a degraded experience ("reviews temporarily unavailable"). Look at the event log for when the breaker opened and closed.',
      },
    },
  ],
};
