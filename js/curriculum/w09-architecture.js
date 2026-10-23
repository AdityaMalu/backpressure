import { G, X, Y } from './util.js';

export default {
  week: '9–10',
  title: 'Architecture & Reliability',
  lessons: [
    // ------------------------------------------------------------------
    {
      id: 'microservices',
      title: 'Microservices',
      minutes: 30,
      summary: 'Splitting a system into independently deployable services buys team autonomy and independent scaling, and charges you in network calls, partial failures and distributed data.',
      body: `
## Monolith first

A **monolith** is one deployable unit. It is not a dirty word: one codebase, in-process calls (nanoseconds, never "partially fail"), one database with real transactions, simple debugging. Most successful companies started as monoliths. A **modular monolith** (strong internal module boundaries, one deploy) captures much of the design benefit with none of the distribution cost.

## What microservices buy you

- **Independent deploys**: team A ships 20× a day without coordinating with team B.
- **Independent scaling**: scale the hot service (search, inventory) without scaling everything.
- **Fault isolation**: a crash in recommendations doesn't kill checkout (*if* you design for it).
- **Technology fit**: the ML team uses Python, the gateway uses Go.
- **Ownership**: Conway's law. Services mirror team boundaries, and that is the real driver.

## What they cost you

- Every call is a **network call**: latency, timeouts, retries, partial failure (previous module).
- **Distributed data**: each service should own its data, so no cross-service joins and no ACID transactions across services. You need sagas, events and eventual consistency.
- **Operational load**: service discovery, deploy pipelines, observability (you *need* distributed tracing), versioned APIs, security between services.
- **Latency stacking**: a request fanning through 6 sequential services pays 6 hops plus their tails.

## Drawing boundaries

Use **domain-driven design**: find **bounded contexts**, areas with their own language and rules (Orders, Payments, Inventory, Identity). Good boundaries have high cohesion inside and few, coarse-grained interactions across them. Smells: two services that must always deploy together, chatty calls in loops, a shared database that both write.

## Communication styles

- **Synchronous** (REST/gRPC): simple request/response; temporal coupling (both must be up).
- **Asynchronous** (events via Kafka, queues): decoupled in time; harder to trace and reason about.
- Rule of thumb: queries sync, state changes async where possible.

## Patterns you'll be asked about

- **API gateway / Backend-for-frontend (BFF)**: one entry point that handles auth, rate limits and routing, and aggregates calls for a specific client (mobile vs web).
- **Service discovery**: services find each other via a registry (Consul, Kubernetes DNS) or a **service mesh** (Envoy/Istio) that also gives you retries, mTLS and metrics.
- **Database per service**: no shared tables; other services use the API or subscribe to events.
- **Saga**: a multi-step business transaction as a sequence of local transactions with **compensating actions** (cancel the reservation if payment fails), coordinated by choreography (events) or an orchestrator.
- **Strangler fig**: migrate a monolith incrementally by routing one capability at a time to a new service.

> **Pitfall** The "distributed monolith": services that share a database, call each other synchronously in long chains and must deploy together. All the costs of microservices, none of the benefits.

> **Interview** You don't need 30 services on the whiteboard. Name 3–6 services along real domain boundaries, say which calls are sync vs async, and point out where a failure in one must not break another.

## The lab

A checkout API calls three services in sequence: **User**, **Inventory** and an external **Payments** provider. Inventory is the hot spot and is under-provisioned, and at **30 s** the User service starts misbehaving. Scale the right service independently and protect the call graph.
`,
      quiz: [
        { q: 'What is the strongest reason to split a service out of a monolith?', options: ['Microservices are always faster', 'A separate team needs to deploy and scale that capability independently', 'To use more servers', 'To avoid writing tests'], answer: 1, why: 'Independent deployment/ownership and scaling are the main benefits, and they matter most when teams are stepping on each other.' },
        { q: 'Order service and Inventory service both write to the same "stock" table. What is this?', options: ['Database per service', 'A distributed monolith smell: shared mutable data couples them', 'Event sourcing', 'CQRS'], answer: 1, why: 'Shared write access means schema changes and invariants span both services. One should own the table; the other uses its API or events.' },
      ],
      lab: {
        title: 'Scale the hot service',
        brief: `**Checkout API** calls **User**, **Inventory** and the external **Payments** provider on each request.

- **Inventory** (80 ms of work per call) is badly under-provisioned.
- From **30 s** to **55 s**, the **User** service turns 10× slower.

Scale Inventory independently and protect the API from User's slowness (user profile data here is non-critical; a fallback is acceptable).

Goals: availability ≥ **97%**, p99 under **3 s** throughout and under **1.2 s** by the end, cost under $2,000/month.`,
        duration: 70,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 1200, readRatio: 0.8, rttMs: 50, retries: 1 }],
          ['lb', 'lb', X(1), Y(1.5)],
          ['api', 'app', X(2), Y(1.5), { instances: 4 }, 'Checkout API'],
          ['user', 'app', X(3), Y(0.3), { instances: 3, baseMs: 10 }, 'User svc'],
          ['inv', 'app', X(3), Y(1.5), { instances: 2, baseMs: 80 }, 'Inventory svc'],
          ['pay', 'external', X(3), Y(2.7), { latencyMs: 250, quotaRps: 2000 }, 'Payments PSP'],
          ['udb', 'sqldb', X(4), Y(0.3), { size: 'M' }, 'Users DB'],
          ['idb', 'sqldb', X(4), Y(1.5), { size: 'M' }, 'Inventory DB'],
        ], ['u>lb', 'lb>api', 'api>user', 'api>inv', 'api>pay', 'user>udb', 'inv>idb']),
        events: [{ at: 30, do: 'slow', target: 'user' }, { at: 55, do: 'unslow', target: 'user' }],
        goals: [
          { metric: 'availability', op: '>=', value: 0.97, label: 'Availability ≥ 97%', at: 'end' },
          { metric: 'p99', op: '<', value: 3000, label: 'p99 under 3 s throughout', after: 8 },
          { metric: 'p99', op: '<', value: 1200, label: 'p99 under 1.2 s at the end', at: 'end' },
          { metric: 'cost', op: '<', value: 2000, label: 'Cost under $2,000/month', after: 0 },
        ],
        hints: [
          'Inventory: 1,200 calls/s × 80 ms. Each S instance has 500 rps of CPU. Check its CPU and scale **only that service** (that is the point of microservices).',
          'For the User service failure: give Checkout API a **timeout**, a **circuit breaker** and a **fallback**. The timeout applies to *all* its calls, so keep it above the healthy tail of the slowest critical dependency: the Payments PSP’s p99 is ~600 ms, so use **~1 s**, not something tuned for User’s 10 ms.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 1200, readRatio: 0.8, rttMs: 50, retries: 1 }],
          ['lb', 'lb', X(1), Y(1.5)],
          ['api', 'app', X(2), Y(1.5), { instances: 4, timeoutMs: 1000, circuitBreaker: true, fallback: true }, 'Checkout API'],
          ['user', 'app', X(3), Y(0.3), { instances: 3, baseMs: 10 }, 'User svc'],
          ['inv', 'app', X(3), Y(1.5), { instances: 5, baseMs: 80 }, 'Inventory svc'],
          ['pay', 'external', X(3), Y(2.7), { latencyMs: 250, quotaRps: 2000 }, 'Payments PSP'],
          ['udb', 'sqldb', X(4), Y(0.3), { size: 'M' }, 'Users DB'],
          ['idb', 'sqldb', X(4), Y(1.5), { size: 'M' }, 'Inventory DB'],
        ], ['u>lb', 'lb>api', 'api>user', 'api>inv', 'api>pay', 'user>udb', 'inv>idb']),
        debrief: 'You scaled one service without touching the others, which is the core promise of microservices. And you saw the core cost: a sequential call chain is only as fast as the sum of its parts, and only as available as its weakest link unless each call is protected. Check the Trace tab: latency stacks hop by hop.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'event-driven',
      title: 'Event-driven architecture',
      minutes: 30,
      summary: 'Instead of telling other services what to do, publish what happened and let them react. Events decouple services in time and ownership, at the price of new consistency puzzles.',
      body: `
## Commands vs. events

- A **command** asks someone to do something: \`SendEmail\`, \`ChargeCard\`. It has one intended receiver and can be rejected.
- An **event** states a fact: \`OrderPlaced\`, \`PaymentCaptured\`. It already happened; any number of subscribers may react.

In a request-driven design, the Order service calls Email, Analytics, Inventory and Loyalty, and knows about all of them. In an event-driven design it publishes \`OrderPlaced\` and is done. New consumers can be added without touching the producer.

## Flavors of event-driven

1. **Event notification**: a thin event ("order 42 placed"); consumers call back for details. Simple, but chatty.
2. **Event-carried state transfer**: the event contains the data consumers need. They keep local copies, so no callbacks and better availability; data is duplicated (eventually consistent).
3. **Event sourcing**: the event log *is* the source of truth; current state is a fold over events. Perfect audit history and time travel, but complex (schema evolution, snapshots, rebuilding projections).
4. **CQRS**: separate write model from read models. Writes produce events; projections build query-optimized views (search index, dashboards). Often paired with event sourcing, but not required.

## The dual-write problem and the outbox

The order service must **save the order** and **publish the event**. If it writes the DB and then publishes to Kafka, a crash in between means an order with no event (or an event with no order). You cannot make two systems atomic with two separate writes.

**Transactional outbox**: in the same DB transaction, insert the order *and* a row in an \`outbox\` table. A relay (polling, or **CDC** with Debezium reading the DB log) publishes outbox rows to Kafka. At-least-once delivery, so consumers dedupe by event ID.

## Choreography vs. orchestration

For multi-step workflows (sagas):
- **Choreography**: services react to each other's events. Decoupled, but the overall flow is implicit and hard to see ("who handles PaymentFailed?").
- **Orchestration**: a coordinator (Temporal, Step Functions, a saga orchestrator) explicitly drives the steps and compensations. The flow is visible and testable; the orchestrator is another component.

## Things that bite

- **Ordering**: only guaranteed per partition. Key by aggregate ID (order_id).
- **Idempotent consumers**: duplicates *will* happen.
- **Schema evolution**: use a schema registry (Avro/Protobuf), add-only changes, version events.
- **Debuggability**: correlation IDs on every event; trace across async hops.
- **Eventual consistency in the UI**: "Your order is being processed."

> **Key idea** Synchronous fan-out makes the user wait for (and depend on) every downstream service. Publishing an event makes the user wait only for the one write that matters.

> **Interview** When a write triggers several side effects (notify, index, analytics, recommendations), say: "commit the write and an outbox event in one transaction; consumers subscribe independently; each is idempotent." It is the standard answer.

## The lab

When an order is placed, the API synchronously calls Email (a third-party with a quota), Analytics and Inventory before responding. It's slow, and when the email provider struggles, checkout fails. Re-architect: write the order, publish one event, and let independent consumer groups do the rest.
`,
      quiz: [
        { q: 'Why not just write to the database, then publish to Kafka, in the request handler?', options: ['Kafka is too slow', 'A crash between the two leaves them inconsistent (dual-write problem); an outbox makes publish part of the DB transaction', 'Kafka cannot store orders', 'It is fine; this is the recommended approach'], answer: 1, why: 'Two independent writes can’t be atomic. The outbox (or CDC) derives the event from the committed transaction.' },
        { q: 'Three teams each need every OrderPlaced event. With Kafka, how?', options: ['Three consumers in one consumer group', 'Three consumer groups subscribed to the topic', 'Three topics written by the producer', 'One consumer that calls the three teams'], answer: 1, why: 'Each consumer group receives every message (pub/sub); within a group, partitions are split among consumers.' },
      ],
      lab: {
        title: 'Publish, don’t call',
        brief: `On every order, **Orders API** synchronously calls **Email provider** (external, 600 ms, quota 400/s), **Analytics** and **Inventory sync** before responding. Checkout is slow, and the email provider's quota is being blown.

Re-architect: the API writes the order to the DB and publishes **one event** to a **Queue** in **pub-sub** mode. Separate **Worker** groups consume it: one calls the email provider, one does analytics, one inventory sync.

Goals: API p99 under **300 ms**, errors under **0.5%**, consumer lag under **30 s**.`,
        duration: 70,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 900, readRatio: 0.6, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1.5)],
          ['api', 'app', X(2), Y(1.5), { instances: 6 }, 'Orders API'],
          ['email', 'external', X(3), Y(0.2), { latencyMs: 600, quotaRps: 400, errorRate: 0.01 }, 'Email provider'],
          ['ana', 'app', X(3), Y(1.2), { instances: 1, baseMs: 40 }, 'Analytics'],
          ['inv', 'app', X(3), Y(2.2), { instances: 1, baseMs: 40 }, 'Inventory sync'],
          ['db', 'sqldb', X(3), Y(3.2), { size: 'M' }, 'Orders DB'],
        ], ['u>lb', 'lb>api', 'api>email', 'api>ana', 'api>inv', 'api>db']),
        goals: [
          { metric: 'p99', op: '<', value: 300, label: 'API p99 under 300 ms', after: 6 },
          { metric: 'errRate', op: '<', value: 0.005, label: 'Errors under 0.5%', after: 6 },
          { metric: 'consumerLag', op: '<', value: 30, label: 'Consumer lag under 30 s', after: 6 },
        ],
        hints: [
          'Delete the API’s direct links to Email, Analytics and Inventory. Add a **Queue (Kafka)** in **pub-sub** mode and connect Orders API → Queue (writes go to the queue). Keep API → Orders DB for reads.',
          'Add three **Workers** (one per consumer group): Queue → each worker. Then Worker 1 → Email provider, Worker 2 → (does analytics work itself), Worker 3 → (inventory sync). Also connect one worker → Orders DB so the order is persisted.',
          'Email calls take 600 ms: an S worker has 100 threads → ~160 msgs/s. You need ~3 email workers for 360 orders/s, and that stays under the provider quota.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 900, readRatio: 0.6, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1.5)],
          ['api', 'app', X(2), Y(1.5), { instances: 6 }, 'Orders API'],
          ['q', 'queue', X(3), Y(1.5), { partitions: 12, mode: 'pub-sub' }, 'order-events'],
          ['we', 'worker', X(4), Y(0.2), { instances: 4 }, 'Email sender'],
          ['wa', 'worker', X(4), Y(1.2), { instances: 2, baseMs: 40 }, 'Analytics'],
          ['wi', 'worker', X(4), Y(2.2), { instances: 2, baseMs: 40 }, 'Order writer'],
          ['email', 'external', X(5), Y(0.2), { latencyMs: 600, quotaRps: 400, errorRate: 0.01 }, 'Email provider'],
          ['db', 'sqldb', X(5), Y(2.5), { size: 'M' }, 'Orders DB'],
        ], ['u>lb', 'lb>api', 'api>q', 'api>db', 'q>we', 'q>wa', 'q>wi', 'we>email', 'wi>db']),
        debrief: 'The API now does one thing (accept the order) and is fast and independent of the email provider. Each consumer group scales and fails on its own. The trade: email arrives seconds later, and every consumer must handle redeliveries (note the email provider’s 1% errors being retried via redelivery).',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'fault-tolerance',
      title: 'Fault tolerance',
      minutes: 30,
      summary: 'Everything fails eventually: disks, servers, zones, dependencies, deploys. Fault-tolerant systems assume failure, remove single points of failure, and degrade instead of collapsing.',
      body: `
## Availability math

| Availability | Downtime / year | Downtime / month |
|---|---|---|
| 99% ("two nines") | 3.65 days | 7.2 h |
| 99.9% | 8.8 h | 43 min |
| 99.95% | 4.4 h | 22 min |
| 99.99% | 53 min | 4.3 min |
| 99.999% | 5.3 min | 26 s |

**In series** (a request needs A *and* B): multiply. Three 99.9% dependencies → 0.999³ ≈ **99.7%**. Every synchronous dependency lowers your ceiling.

**In parallel** (A *or* B can serve): 1 − (1 − a)². Two independent 99% replicas → **99.99%**. Redundancy is how you buy nines, *if* failures are independent.

## Single points of failure (SPOFs)

Walk every box and arrow in your diagram and ask "what if this dies?" Usual suspects: the one database primary, a single load balancer, a single NAT gateway, one cache node with no fallback, a single region, a config service everyone needs at startup, a certificate that expires, a person who's the only one who knows how to deploy.

## Redundancy and failure domains

- **N+1 / N+2**: provision so that losing one (or two) units still leaves enough capacity. Three nodes at 60% each survive losing one (2 at 90%); three at 80% don't.
- **Failure domains**: instance → rack → availability zone → region → provider. Spread replicas across **zones** at minimum; across regions for disaster recovery.
- **Correlated failures** break the independence assumption: the same bad deploy, the same expired cert, the same kernel bug on every node. Mitigate with staged rollouts and diversity.

## Detect, contain, recover

- **Detect**: health checks, heartbeats, SLO-based alerts.
- **Contain**: bulkheads, circuit breakers, timeouts, **cell-based architecture** (independent copies of the full stack, each serving a slice of customers, so a bad cell hurts only a fraction).
- **Recover**: automatic failover, restarts (crash-only design: make startup the recovery path), rollbacks.

## Graceful degradation

Decide in advance what the product does when a dependency is gone:
- Recommendations down → show bestsellers.
- Search down → show categories.
- Payments provider down → queue the order and retry, or offer another provider.
- Read-only mode when the primary is failing over.

**Static stability**: the system keeps working in its current state even when the control plane (config, autoscaler, service discovery) is unavailable. Don't make the data path depend on the thing that's broken.

## Chaos engineering

Netflix's Chaos Monkey randomly kills production instances during business hours so that engineers *must* build for it. Mature practice: hypothesis ("killing a cache node won't raise error rate above 0.1%"), small blast radius, run in production, automate. **Game days** rehearse big failures (region loss) with the whole team.

> **Key idea** Redundancy that's never exercised is a hope, not a guarantee. Failover paths that only run during real outages are the ones that fail.

> **Interview** After drawing your design, proactively walk through failures: "If a cache node dies… if the primary dies… if an AZ goes down…" and state the user-visible impact and recovery time for each.

## The lab: chaos day

A three-tier system with exactly one of everything. During the run: an app server group dies, the cache dies, and the database primary dies. Make every tier redundant (with health checks and failover), and keep enough capacity that losing a component doesn't overload the survivors.
`,
      quiz: [
        { q: 'A request synchronously depends on 5 services, each 99.9% available (independent). Upper bound on availability?', options: ['99.9%', '~99.5%', '99.99%', '95%'], answer: 1, why: '0.999⁵ ≈ 0.995. Series dependencies multiply, which is why critical paths should have few hard dependencies.' },
        { q: 'Two app servers each run at 75% CPU. One dies. What happens?', options: ['Nothing, they are redundant', 'The survivor gets ~150% load and fails too: redundancy without N+1 capacity', 'The load balancer adds a server', 'Latency halves'], answer: 1, why: 'Redundancy only helps if the remaining capacity can absorb the load. Plan for N+1.' },
      ],
      lab: {
        title: 'Chaos day',
        brief: `A three-tier app with **exactly one of everything**. During the run:
- **20 s**: app group **App A** dies,
- **40 s**: the **cache** dies (and stays down),
- **60 s**: the **SQL primary** dies.

Make the system survive all three with availability ≥ **95%** (three disasters in 90 seconds is a brutal window) and p99 under **800 ms** at the end, for under **$2,500/month**.`,
        duration: 90,
        graph: G([
          ['u', 'client', X(0), Y(1.2), { rps: 2500, readRatio: 0.9, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1.2), { healthChecks: false }],
          ['a', 'app', X(2), Y(1.2), { instances: 6 }, 'App A'],
          ['cache', 'cache', X(3), Y(0.3), { memoryGB: 32 }],
          ['db', 'sqldb', X(4), Y(1.2), { size: 'M', autoFailover: false }],
        ], ['u>lb', 'lb>a', 'a>cache', 'cache>db', 'a>db']),
        events: [{ at: 20, do: 'kill', target: 'a' }, { at: 40, do: 'kill', target: 'cache' }, { at: 60, do: 'kill', target: 'db' }],
        goals: [
          { metric: 'availability', op: '>=', value: 0.95, label: 'Availability ≥ 95%', at: 'end' },
          { metric: 'p99', op: '<', value: 800, label: 'p99 under 800 ms at the end', at: 'end' },
          { metric: 'cost', op: '<', value: 2500, label: 'Cost under $2,500/month', after: 0 },
        ],
        hints: [
          'Add a second app group (**App B**) behind the LB with **health checks** on. Each group must be able to carry all 2,500 rps alone, roughly 7 S instances.',
          'When the cache dies, every read falls through to the primary (~2,250 reads + 1,000 write units). An M primary (3k) can’t take that alone. Add **read replicas** for the fallback path, or a bigger primary.',
          'Turn on **Automatic failover** on the primary and connect it to a replica, so a replica gets promoted at 60 s.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.2), { rps: 2500, readRatio: 0.9, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1.2), { healthChecks: true }],
          ['a', 'app', X(2), Y(0.4), { instances: 7 }, 'App A'],
          ['b', 'app', X(2), Y(2), { instances: 7 }, 'App B'],
          ['cache', 'cache', X(3), Y(0), { memoryGB: 32 }],
          ['db', 'sqldb', X(4), Y(0.8), { size: 'M', autoFailover: true }],
          ['r1', 'replica', X(5), Y(0.4), { size: 'M' }, 'Replica 1'],
          ['r2', 'replica', X(5), Y(1.6), { size: 'M' }, 'Replica 2'],
        ], ['u>lb', 'lb>a', 'lb>b', 'a>cache', 'b>cache', 'cache>db', 'a>db', 'b>db', 'a>r1', 'a>r2', 'b>r1', 'b>r2', 'db>r1', 'db>r2']),
        debrief: 'Each failure exercised a different mechanism: health checks (app group), graceful fallback plus enough DB capacity (cache), and automatic failover (primary). Each needed **spare capacity** in the survivors. Check the event log: you can see detection, ejection, fallback and promotion in order.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'observability',
      title: 'Logging, metrics & tracing',
      minutes: 30,
      summary: 'You can’t fix what you can’t see. Metrics tell you something is wrong, traces tell you where, logs tell you why. SLOs tell you whether it matters.',
      body: `
## The three pillars

**Metrics**: numeric time series, cheap to store and query, perfect for dashboards and alerts.
- **Counter** (only goes up: requests, errors), **gauge** (current value: queue depth, memory), **histogram** (distribution: latency buckets → p50/p99).
- Watch **cardinality**: a label like \`user_id\` creates millions of series and melts your metrics system.

**Logs**: discrete events with context. Make them **structured** (JSON with fields, not free text) so you can filter (\`level=error AND order_id=…\`). Include a **request/correlation ID** in every line. Log levels; sample noisy debug logs; never log secrets or full PII.

**Traces**: the path of one request through many services. A trace is a tree of **spans** (one per operation: HTTP call, DB query), each with start, duration and attributes. Context (trace ID, parent span ID) propagates through headers (W3C \`traceparent\`). Tools: OpenTelemetry (instrumentation standard), Jaeger, Tempo, Honeycomb, Datadog APM.
- **Sampling**: head-based (decide at the start: cheap, may miss rare errors) vs tail-based (decide after seeing the whole trace: keep all errors and slow ones).

Metrics answer *is something wrong?*, traces *where?*, logs *why?*

## What to measure

**RED method** (for every service, request-driven): **R**ate, **E**rrors, **D**uration.

**USE method** (for every resource: CPU, disk, pool): **U**tilization, **S**aturation (queueing), **E**rrors.

**Google's four golden signals**: latency, traffic, errors, saturation.

Measure latency as **histograms → percentiles**, never just averages. Separate latency of successful vs. failed requests (fast failures make averages look great).

## SLIs, SLOs and error budgets

- **SLI** (indicator): what you measure, e.g. "fraction of requests that succeed in < 300 ms".
- **SLO** (objective): the target, e.g. "99.9% over 30 days".
- **SLA**: the contract with customers (with penalties), looser than the SLO.
- **Error budget**: 100% − SLO = 0.1% ≈ 43 minutes/month you're *allowed* to fail. Burning it fast → freeze risky deploys; plenty left → ship faster. It turns reliability into an engineering trade-off instead of an argument.

### Alerting
Alert on **symptoms users feel** (SLO burn rate: "at this rate we exhaust the monthly budget in 2 days"), not on every cause (CPU 80%). Every page should be actionable; alert fatigue makes on-call ignore the real one. Use multi-window burn-rate alerts (fast burn → page, slow burn → ticket).

## Debugging workflow

1. Dashboard: which SLI is burning? Since when? (correlate with deploys)
2. RED per service: where do errors/latency originate?
3. Traces: grab slow/error exemplars; find the span that dominates.
4. Logs for that span's service/request ID: the actual error.
5. USE on the implicated resource: saturated pool? Disk? Lock?

> **Interview** Mention observability as part of every design: "Each service emits RED metrics and OpenTelemetry traces; we alert on SLO burn rate for p99 latency and availability; logs are structured with request IDs."

## The lab: find the culprit

Checkout p99 is terrible and nobody knows why. The system has many services and databases. Use the **Trace** tab (a request waterfall) and the **Inspect** panel (the USE/RED numbers per component) to find the root cause, then fix it **without** adding capacity blindly: the budget is tight.
`,
      quiz: [
        { q: 'Which is the best primary alert for an API?', options: ['CPU above 80% on any host', 'SLO burn rate: error budget for availability/latency is being consumed too fast', 'Any ERROR log line', 'Disk at 50%'], answer: 1, why: 'Alert on user-facing symptoms tied to your objective. Causes like CPU are for dashboards and diagnosis.' },
        { q: 'Why is a `user_id` label on a request-count metric a bad idea?', options: ['It is personal data, which metrics cannot store', 'Cardinality explosion: one time series per user overwhelms the metrics backend', 'Prometheus forbids string labels', 'It makes counters decrease'], answer: 1, why: 'Each label combination is a separate series. Per-user detail belongs in logs and traces.' },
      ],
      lab: {
        title: 'Find the culprit',
        brief: `Checkout p99 is several seconds and the team has been adding servers without effect.

Use the **Trace** tab (start the simulation, then open Trace) and click through components in **Inspect** to find the root cause. The fix is a configuration change, not more hardware.

Goals: p99 under **500 ms**, errors under 1%, cost under **$1,600/month**. No new capacity needed.`,
        duration: 45,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 1200, readRatio: 0.85, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1.5)],
          ['api', 'app', X(2), Y(1.5), { instances: 6 }, 'Checkout API'],
          ['cart', 'app', X(3), Y(0.3), { instances: 4 }, 'Cart svc'],
          ['price', 'app', X(3), Y(1.5), { instances: 4 }, 'Pricing svc'],
          ['promo', 'app', X(3), Y(2.7), { instances: 4 }, 'Promotions svc'],
          ['cdb', 'cache', X(4), Y(0.3), { memoryGB: 16 }, 'Cart cache'],
          ['pdb', 'sqldb', X(4), Y(1.5), { size: 'M' }, 'Pricing DB'],
          ['mdb', 'sqldb', X(4), Y(2.7), { size: 'M', indexed: false }, 'Promotions DB'],
        ], ['u>lb', 'lb>api', 'api>cart', 'api>price', 'api>promo', 'cart>cdb', 'price>pdb', 'promo>mdb']),
        goals: [
          { metric: 'p99', op: '<', value: 500, label: 'p99 under 500 ms', after: 6 },
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 6 },
          { metric: 'cost', op: '<', value: 1600, label: 'Cost under $1,600/month', after: 0 },
        ],
        hints: [
          'Open **Trace** while running. Which span is widest? Follow it down.',
          'Promotions svc spends most of its time waiting on the Promotions DB. Inspect the DB: utilization, and its configuration.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 1200, readRatio: 0.85, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1.5)],
          ['api', 'app', X(2), Y(1.5), { instances: 6 }, 'Checkout API'],
          ['cart', 'app', X(3), Y(0.3), { instances: 4 }, 'Cart svc'],
          ['price', 'app', X(3), Y(1.5), { instances: 4 }, 'Pricing svc'],
          ['promo', 'app', X(3), Y(2.7), { instances: 4 }, 'Promotions svc'],
          ['cdb', 'cache', X(4), Y(0.3), { memoryGB: 16 }, 'Cart cache'],
          ['pdb', 'sqldb', X(4), Y(1.5), { size: 'M' }, 'Pricing DB'],
          ['mdb', 'sqldb', X(4), Y(2.7), { size: 'M', indexed: true }, 'Promotions DB'],
        ], ['u>lb', 'lb>api', 'api>cart', 'api>price', 'api>promo', 'cart>cdb', 'price>pdb', 'promo>mdb']),
        debrief: 'The trace pointed at one span, Promotions → Promotions DB, and the USE view showed the DB saturated by full scans. Adding API servers could never help: the bottleneck was three hops away. Root cause first, capacity second.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'disaster-recovery',
      title: 'Disaster recovery',
      minutes: 30,
      summary: 'Regions go down. Data gets deleted. Disaster recovery is the plan, and the rehearsed practice, for getting back within a defined time, losing no more than a defined amount of data.',
      body: `
## RPO and RTO

- **RPO (Recovery Point Objective)**: how much **data** you can afford to lose, measured in time. RPO = 0 means no acknowledged write may ever be lost.
- **RTO (Recovery Time Objective)**: how long you can be **down** before service is restored.

Every DR decision trades cost against these two numbers. A blog might accept RPO = 24 h, RTO = 1 day. A payment ledger wants RPO = 0, RTO = minutes.

## DR strategies (cheapest → fastest)

| Strategy | How | RPO | RTO | Cost |
|---|---|---|---|---|
| **Backup & restore** | Regular backups shipped off-site; rebuild infra when needed | Hours | Hours–days | $ |
| **Pilot light** | Data continuously replicated to the DR region; minimal core running; scale up on disaster | Seconds–minutes | Tens of minutes | $$ |
| **Warm standby** | Scaled-down full copy always running in DR region | Seconds | Minutes | $$$ |
| **Multi-site active-active** | Full capacity in multiple regions serving traffic | ~0 (with sync or conflict handling) | ~0 (DNS/anycast shift) | $$$$ |

## Backups done right

- **Full + incremental** backups, plus **point-in-time recovery** (continuous WAL archiving) so you can restore to the second before \`DROP TABLE\`.
- The **3-2-1 rule**: 3 copies, 2 media, 1 off-site (and ideally one **immutable**/air-gapped against ransomware and fat-fingered deletes).
- **Replication is not a backup**: it faithfully replicates your accidental \`DELETE\`.
- **Untested backups don't exist.** Regularly restore into a scratch environment and verify.

## Cross-region replication

- **Async** cross-region replication (typical): small RPO (lag window, usually < 1 s), no latency penalty on writes.
- **Sync** across regions: RPO = 0, but every write pays the inter-region round trip (60–150 ms), and a region failure can block writes unless you use a quorum across 3+ regions (Spanner, CockroachDB).
- Global databases (Aurora Global, Cosmos DB, DynamoDB global tables) package these trade-offs.

## Failing over a region

1. **Detect**: health checks from multiple vantage points (don't fail over because *your monitoring* lost connectivity).
2. **Decide**: automated for well-understood failures; human-in-the-loop for ambiguous ones (avoid flapping and split brain).
3. **Promote** data in the standby region (replica → primary).
4. **Shift traffic**: DNS (mind TTLs), anycast, or a global load balancer.
5. **Fail back** later, carefully (resync the old region first).

**Capacity**: the surviving region must take 100% of traffic. Running two regions at 70% each means neither survives the other's loss.

## Practice

Runbooks, **game days** that actually fail over production (or a production-like environment), and measuring achieved RTO/RPO in those drills. Organizations that rehearse recover in minutes; those that don't discover their DR plan doesn't work during the disaster.

> **Interview** State the RPO/RTO you're designing for, then pick the strategy: "Async replication to a warm standby in us-west; RPO ≈ seconds, RTO ≈ 5 minutes via health-checked DNS with a 30 s TTL. Daily snapshots + PITR for logical corruption."

## The lab

The primary region **us-east** fails at **30 s**. The us-west region has app servers but its database path depends on the us-east primary. Build a standby that takes over automatically. The business also demands **RPO = 0**: no acknowledged write may be lost.
`,
      quiz: [
        { q: 'A developer accidentally runs DELETE FROM orders. Which protects you?', options: ['Synchronous replication to 3 replicas', 'Point-in-time recovery from backups / WAL archive', 'Multi-AZ failover', 'A bigger instance'], answer: 1, why: 'Replication copies the delete everywhere instantly. You need history: PITR or snapshots.' },
        { q: 'RPO = 0 across regions requires…', options: ['Async replication with a short lag', 'Writes acknowledged only after the remote region (or a cross-region quorum) has them', 'Hourly snapshots', 'A CDN'], answer: 1, why: 'Anything acknowledged before reaching another region can be lost with the region. That costs write latency.' },
      ],
      lab: {
        title: 'Lose a region, lose nothing',
        brief: `Two regions behind health-checked DNS. The SQL primary lives in **us-east**; us-west only has app servers.

At **30 s**, **us-east** suffers a total outage.

Build a standby: a **Read Replica in us-west** fed by the primary, with **automatic failover**. The business requires **RPO = 0** (zero lost writes), availability ≥ **93%** over this short, disaster-heavy window, and p99 under 500 ms at the end.`,
        duration: 90,
        graph: G([
          ['u', 'client', X(0), Y(1.5), { rps: 1500, readRatio: 0.85, rttMs: 60 }],
          ['dns', 'dns', X(1), Y(1.5), { mode: 'round-robin', healthChecks: true, ttl: 5 }],
          ['lbE', 'lb', X(2), Y(0.5), { region: 'us-east' }, 'LB us-east'],
          ['lbW', 'lb', X(2), Y(2.5), { region: 'us-west' }, 'LB us-west'],
          ['appE', 'app', X(3), Y(0.5), { instances: 4, region: 'us-east' }, 'App us-east'],
          ['appW', 'app', X(3), Y(2.5), { instances: 4, region: 'us-west' }, 'App us-west'],
          ['db', 'sqldb', X(4), Y(0.5), { size: 'L', region: 'us-east', autoFailover: false }, 'Primary (us-east)'],
        ], ['u>dns', 'dns>lbE', 'dns>lbW', 'lbE>appE', 'lbW>appW', 'appE>db', 'appW>db']),
        events: [{ at: 30, do: 'region', region: 'us-east' }],
        goals: [
          { metric: 'lostWrites', op: '<=', value: 0, label: 'Zero lost writes (RPO = 0)', at: 'end' },
          { metric: 'availability', op: '>=', value: 0.93, label: 'Availability ≥ 93% over the run', at: 'end' },
          { metric: 'p99', op: '<', value: 500, label: 'p99 under 500 ms at the end', at: 'end' },
        ],
        hints: [
          'Add a **Read Replica**, set its region to **us-west**, connect Primary → Replica, and turn on **Automatic failover** on the primary. Also connect App us-west → Replica so us-west reads keep working while the failover is in progress.',
          'With async replication, the writes in the lag window are lost at failover. Set the primary’s replication to **sync**: RPO = 0, at the cost of some write latency.',
          'After the outage, us-west carries 100% of traffic. Check that App us-west has enough instances.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1.5), { rps: 1500, readRatio: 0.85, rttMs: 60 }],
          ['dns', 'dns', X(1), Y(1.5), { mode: 'round-robin', healthChecks: true, ttl: 5 }],
          ['lbE', 'lb', X(2), Y(0.5), { region: 'us-east' }, 'LB us-east'],
          ['lbW', 'lb', X(2), Y(2.5), { region: 'us-west' }, 'LB us-west'],
          ['appE', 'app', X(3), Y(0.5), { instances: 4, region: 'us-east' }, 'App us-east'],
          ['appW', 'app', X(3), Y(2.5), { instances: 5, region: 'us-west' }, 'App us-west'],
          ['db', 'sqldb', X(4), Y(0.5), { size: 'L', region: 'us-east', autoFailover: true, replication: 'sync' }, 'Primary (us-east)'],
          ['rep', 'replica', X(4), Y(2.5), { size: 'L', region: 'us-west' }, 'Standby (us-west)'],
        ], ['u>dns', 'dns>lbE', 'dns>lbW', 'lbE>appE', 'lbW>appW', 'appE>db', 'appW>db', 'appW>rep', 'db>rep']),
        debrief: 'You built a warm standby: replication into another region, health-checked DNS, automatic promotion and enough capacity in the survivor. Sync replication bought RPO = 0 at the cost of slower writes. Try async: you’ll see the lost-writes counter tick up at failover. That is the RPO trade-off made concrete.',
      },
    },
  ],
};
