import { G, X, Y } from './util.js';

export default {
  week: '3–4',
  title: 'Databases',
  lessons: [
    // ------------------------------------------------------------------
    {
      id: 'sql-vs-nosql',
      title: 'SQL vs. NoSQL',
      minutes: 25,
      summary: 'Relational databases give you transactions, joins and a schema. NoSQL stores trade some of that for horizontal scale and flexible data models. Choosing well starts with your access patterns.',
      body: `
## Relational (SQL) databases

Postgres, MySQL, SQL Server, Oracle. Data lives in **tables** with a fixed **schema**; relationships are expressed with **foreign keys** and queried with **joins**. Their superpowers:

- **ACID transactions**: Atomicity (all or nothing), Consistency (constraints hold), Isolation (concurrent transactions don't see each other's half-done work), Durability (committed = on disk).
- **Ad-hoc queries**: any question you can phrase in SQL, the optimizer will try to answer, even ones you didn't plan for.
- **Integrity**: unique constraints, foreign keys, check constraints enforced by the database, not by hopeful application code.

Their limit: **one primary handles all writes**. You can scale reads with replicas and scale the box up a long way, but writes beyond one machine require sharding, which breaks joins and transactions across shards (next lessons).

## NoSQL families

"NoSQL" is not one thing. Each family optimizes a different access pattern:

| Family | Examples | Model | Great for |
|---|---|---|---|
| Key-value | Redis, DynamoDB, Riak | \`get(key)\` / \`put(key, value)\` | Sessions, caches, carts, counters |
| Document | MongoDB, Couchbase, Firestore | JSON documents, nested | Product catalogs, user profiles, CMS |
| Wide-column | Cassandra, ScyllaDB, HBase, Bigtable | Partition key → sorted rows | Time series, messages, feeds, IoT: huge write volume |
| Graph | Neo4j, Neptune | Nodes + edges | Social graphs, fraud rings, recommendations |
| Search | Elasticsearch, OpenSearch | Inverted index | Full-text search, log analytics |
| Time-series | InfluxDB, TimescaleDB, Prometheus | Timestamped points | Metrics, monitoring |

Most NoSQL stores are **partitioned from day one**: data is spread across nodes by a partition key, so adding nodes adds both storage and write throughput. The price:

- **Query flexibility**: you model tables around queries. "Messages by conversation, newest first" is a perfect Cassandra table; "all messages containing 'refund' across all users" is not.
- **Weaker guarantees**: many default to eventual consistency, single-item atomicity, no joins.
- **Denormalization**: the same data is copied into several tables, one per query pattern, and your application keeps the copies in sync.

## ACID vs. BASE

NoSQL systems are often described as **BASE**: *Basically Available, Soft state, Eventually consistent*. It is a spectrum, not a binary: DynamoDB and MongoDB support transactions now; Cassandra lets you choose consistency per query; Spanner and CockroachDB are SQL *and* horizontally scalable (NewSQL), paying for it with coordination latency.

## How to choose

Ask, in order:

1. **What are the access patterns?** Key lookups → KV. Rich relational queries and reporting → SQL. Append-heavy, time-ordered by entity → wide-column.
2. **What's the write volume?** If it fits on one big primary (thousands to tens of thousands of writes/s), SQL is simpler. Hundreds of thousands per second → partitioned store.
3. **What consistency do you need?** Money, inventory, uniqueness → transactions. Likes, views, feeds → eventual is fine.
4. **How will the schema evolve?** Documents handle heterogeneous, fast-changing shapes; SQL migrations are manageable but deliberate.

> **Key idea** Default to a relational database. Move specific workloads to specialized stores when a concrete requirement (write scale, latency, data shape) forces you, and say which requirement in an interview.

Real systems are **polyglot**: Postgres for accounts and orders, Redis for sessions and rate limits, Cassandra for messages, Elasticsearch for search, S3 for blobs.

## Write cost in a replicated cluster

In a leaderless store like Cassandra with replication factor **RF = 3**, every write is performed on **3 nodes**. Cluster write capacity ≈ (nodes × per-node capacity) ÷ RF. Reads at consistency QUORUM contact 2 of the 3 replicas. The simulator models exactly this: when you size a NoSQL cluster, account for RF.

> **Interview** Justify the database with the access pattern and scale: "Messages are written 100k/s and always read by conversation in time order, so a wide-column store partitioned by conversation_id with a time-sorted clustering key fits; we don't need cross-conversation joins."

## The lab

An IoT platform ingests **8,000 sensor writes/s** and serves 2,000 reads/s. The team put it on a single SQL primary. Even the biggest instance can't keep up. Move the workload to a store whose write capacity grows with node count.
`,
      quiz: [
        { q: 'Which workload is the strongest fit for a wide-column store like Cassandra?', options: ['Bank transfers between accounts', 'Chat messages written at 200k/s, read per conversation newest-first', 'Ad-hoc analyst reports joining 12 tables', 'A product catalog with 5,000 items'], answer: 1, why: 'Huge write volume with a single, predictable access pattern (partition = conversation, clustering = time) is exactly what wide-column stores are built for.' },
        { q: 'A Cassandra cluster has 9 nodes, RF=3, each node does ~5k writes/s. Roughly what cluster-wide write rate can it sustain?', options: ['5k/s', '15k/s', '45k/s', '135k/s'], answer: 1, why: 'Each logical write lands on 3 replicas: 9 × 5k ÷ 3 = 15k writes/s.' },
      ],
      lab: {
        title: 'Outgrow the primary',
        brief: `**8,000 writes/s** of sensor readings plus 2,000 reads/s. Each SQL write costs ~4 work units, so the primary needs ~34k units/s. The biggest instance (XL) has 12k.

Replace the database with a store that **scales writes horizontally**. Goals: errors under 1%, p99 under 300 ms, cost under **$4,000/month**.`,
        duration: 45,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 10000, readRatio: 0.2 }, 'Sensors + dashboards'],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 16, size: 'M' }, 'Ingest API'],
          ['db', 'sqldb', X(3), Y(1), { size: 'XL' }],
        ], ['u>lb', 'lb>app', 'app>db']),
        goals: [
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 6 },
          { metric: 'p99', op: '<', value: 300, label: 'p99 under 300 ms', after: 6 },
          { metric: 'cost', op: '<', value: 4000, label: 'Cost under $4,000/month', after: 0 },
        ],
        hints: [
          'Drag in a **NoSQL (Cassandra)** node, connect Ingest API → NoSQL, and delete the SQL primary (select it, press Delete).',
          'Work per second = reads × (replicas consulted) + writes × RF. With RF 3 and QUORUM: 2,000×2 + 8,000×3 = 28k units. At 5k per node and ~65% target, that’s ~9 nodes.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 10000, readRatio: 0.2 }, 'Sensors + dashboards'],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 16, size: 'M' }, 'Ingest API'],
          ['db', 'nosql', X(3), Y(1), { nodes: 9, rf: 3, consistency: 'QUORUM' }],
        ], ['u>lb', 'lb>app', 'app>db']),
        debrief: 'A single SQL primary hits a hard ceiling on writes; a partitioned store scales write throughput with node count. You paid for it: no joins, query-driven modeling, and every write costs RF× the work. That trade is worth it only when write scale actually demands it.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'indexing-transactions',
      title: 'Indexing & transactions',
      minutes: 30,
      summary: 'Indexes decide whether a query touches 3 pages or 3 million. Transactions and isolation levels decide what concurrent users can see. Both have costs you must understand.',
      body: `
## What an index is

Without an index, \`SELECT * FROM orders WHERE user_id = 42\` must read **every row** (a full table scan): O(n). An index is a separate, sorted data structure mapping column values to row locations, turning that into O(log n): a handful of page reads.

**B-tree / B+tree** (the default in Postgres, MySQL InnoDB): a balanced, wide tree (hundreds of keys per node), so even a billion rows is ~4 levels deep. Supports equality, ranges (\`BETWEEN\`, \`<\`), prefix matches and ordered scans (\`ORDER BY created_at\`).

**Hash index**: O(1) equality lookups only, no ranges. **LSM trees** (Cassandra, RocksDB, many NoSQL) buffer writes in memory and flush sorted files, optimizing for write throughput at some read cost. **Inverted indexes** power full-text search. **Geospatial** (R-tree, geohash, S2) power "find nearby".

### Composite and covering indexes

An index on \`(user_id, created_at)\` serves:
- \`WHERE user_id = ?\` ✓
- \`WHERE user_id = ? AND created_at > ?\` ✓
- \`WHERE user_id = ? ORDER BY created_at DESC LIMIT 20\` ✓ (no sort needed)
- \`WHERE created_at > ?\` ✗ (the **leftmost prefix** rule: the index is sorted by user_id first)

A **covering index** contains every column the query needs, so the database never touches the table itself: an *index-only scan*.

### The cost of indexes

Every index must be updated on every INSERT/UPDATE/DELETE of the indexed columns, so writes slow down and storage grows. Index what your queries filter, join and sort on, and verify with \`EXPLAIN ANALYZE\`. A query plan that says **Seq Scan** on a big table in a hot path is a bug.

> **Pitfall** Functions on indexed columns defeat the index: \`WHERE LOWER(email) = ?\` can't use an index on \`email\` (create an expression index instead). Same for implicit type casts and leading wildcards (\`LIKE '%foo'\`).

## Transactions

A transaction groups statements into one atomic unit:

\`\`\`sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;   -- both happen, or (on ROLLBACK / crash) neither does
\`\`\`

Durability comes from the **write-ahead log (WAL)**: the change is appended to a sequential log and fsynced before COMMIT returns; data pages are updated lazily. Crash recovery replays the log.

## Isolation levels and anomalies

Running transactions concurrently creates anomalies. Isolation levels trade safety for throughput:

| Level | Dirty read | Non-repeatable read | Phantom | Write skew |
|---|---|---|---|---|
| Read uncommitted | possible | possible | possible | possible |
| **Read committed** (Postgres default) | ✗ | possible | possible | possible |
| Repeatable read / snapshot (MySQL default) | ✗ | ✗ | mostly ✗ | possible |
| **Serializable** | ✗ | ✗ | ✗ | ✗ |

- **Dirty read**: seeing another transaction's uncommitted change.
- **Non-repeatable read**: reading the same row twice and getting different values.
- **Phantom**: re-running a range query and getting new rows.
- **Write skew**: two transactions each read a condition ("at least one doctor on call"), then each write based on it, and together they violate it.

Most databases implement isolation with **MVCC** (multi-version concurrency control): readers see a consistent snapshot without blocking writers. **Serializable** adds either strict two-phase locking or serializable snapshot isolation (SSI), which detects dangerous patterns and **aborts** transactions, which your code must retry.

### Concurrency control in practice
- **Pessimistic**: \`SELECT … FOR UPDATE\` locks rows. Simple, but contention and deadlocks.
- **Optimistic**: read a \`version\` column, then \`UPDATE … WHERE id = ? AND version = ?\`; if 0 rows changed, someone else won, so retry. Great when conflicts are rare.
- **Atomic operations**: \`UPDATE stock SET qty = qty - 1 WHERE id = ? AND qty > 0\` avoids read-modify-write races entirely.

> **Interview** For money or inventory, say how you prevent the race: a transaction with the right isolation, row locks, a conditional update, or a unique constraint. "Two users buy the last item at the same time" is a classic follow-up.

## The lab

A checkout service is melting its database. Someone shipped a query without an index, and someone else set the isolation level to **serializable** "to be safe". Fix the database without throwing money at it.
`,
      quiz: [
        { q: 'An index exists on (country, city, created_at). Which query can NOT use it efficiently?', options: ["WHERE country='IN'", "WHERE country='IN' AND city='Pune'", "WHERE city='Pune'", "WHERE country='IN' AND city='Pune' ORDER BY created_at"], answer: 2, why: 'Leftmost-prefix rule: the index is sorted by country first; filtering only on city skips the leading column.' },
        { q: 'Two transactions each check "is at least one doctor on call?" (yes, two are), then each takes a doctor off call. Both commit. Which anomaly is this?', options: ['Dirty read', 'Phantom read', 'Write skew', 'Lost update caused by no WAL'], answer: 2, why: 'Each transaction read a shared condition and wrote a different row based on it. Only serializable isolation (or explicit locking of the rows read) prevents write skew.' },
        { q: 'Why not index every column?', options: ['Databases limit tables to 3 indexes', 'Each index slows every write and uses storage; unused indexes are pure cost', 'Indexes make reads slower', 'Indexes break transactions'], answer: 1, why: 'Every insert/update must maintain every affected index. Index for your actual query patterns.' },
      ],
      lab: {
        title: 'Fix the slow checkout',
        brief: `**1,500 rps** (90% reads) against an M-size primary that should be plenty. Instead it's pinned at 100%.

Two misconfigurations are hiding in the **SQL Primary** settings. Fix them so that p99 drops under **300 ms** with errors under 1%, **without** upgrading the instance (budget: $450/month total).`,
        duration: 40,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 1500, readRatio: 0.9, rttMs: 40 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 4 }, 'Checkout'],
          ['db', 'sqldb', X(3), Y(1), { size: 'M', indexed: false, isolation: 'serializable' }],
        ], ['u>lb', 'lb>app', 'app>db']),
        goals: [
          { metric: 'p99', op: '<', value: 300, label: 'p99 under 300 ms', after: 6 },
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 6 },
          { metric: 'cost', op: '<', value: 450, label: 'Cost under $450/month', after: 0 },
        ],
        hints: [
          'Select the SQL Primary. Its reads cost 15× because **Queries use indexes** is off: every read is a table scan.',
          'Indexing alone gets you close but the database is still hot. **Serializable** isolation makes every write ~2.2× more expensive (locking, aborts and retries). Checkout reads/writes here don’t need it: use **read-committed** with targeted row locks for the stock decrement.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 1500, readRatio: 0.9, rttMs: 40 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 4 }, 'Checkout'],
          ['db', 'sqldb', X(3), Y(1), { size: 'M', indexed: true, isolation: 'read-committed' }],
        ], ['u>lb', 'lb>app', 'app>db']),
        debrief: 'A missing index is the single most common cause of database meltdowns, and the cheapest to fix. Stronger isolation is not free "safety": it costs throughput. Use the weakest level that is correct, plus targeted locks or conditional updates where races matter.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'replication',
      title: 'Replication & partitioning',
      minutes: 30,
      summary: 'Copies of your data on multiple machines give you read scale and survival when a machine dies, and introduce lag, failover and consistency puzzles.',
      body: `
## Why replicate?

1. **Availability**: if one machine dies, another has the data.
2. **Read scaling**: spread reads across copies.
3. **Latency**: put copies near users (other regions).

## Leader–follower (primary–replica)

The most common setup (Postgres, MySQL, MongoDB replica sets). All writes go to the **leader**, which streams its change log (WAL/binlog) to **followers**. Followers apply changes in order and serve reads.

**Synchronous vs asynchronous replication:**

| | Async | Sync | Semi-sync |
|---|---|---|---|
| Write latency | Leader only | + slowest replica round trip | + fastest replica |
| Data loss on leader crash | Last few ms–s of writes | None | None (one copy guaranteed) |
| Replica down → | Nothing | **Writes block** | Fine while ≥1 replica acks |

Most production systems use async (or semi-sync) within a region, and async across regions.

### Replication lag and its anomalies

Async replicas are usually milliseconds behind, but under heavy write load or a slow replica, lag can grow to seconds or minutes. Users then see:

- **Read-your-writes violations**: you update your profile, refresh, and see the old one (the read hit a lagging replica).
- **Monotonic read violations**: refresh twice and see newer then older data (two different replicas).
- **Causality violations**: you see a reply before the message it replies to.

Fixes (more in Week 7–8): read your own recent writes from the leader, pin a user's session to one replica, or pass a replication position (LSN) and wait until the replica has caught up.

### Failover

When the leader dies, a follower must be **promoted**:
1. Detect failure (heartbeat timeouts: too short → false failovers, too long → longer outage).
2. Choose the most up-to-date follower.
3. Reconfigure clients/routing to the new leader.

Dangers: with async replication, **writes not yet replicated are lost**. If the old leader comes back still thinking it's leader, you get **split brain**: two leaders accepting conflicting writes. Fencing tokens and consensus (Raft in etcd, Patroni for Postgres) exist to prevent that.

## Multi-leader and leaderless

- **Multi-leader**: each region has a writable leader; leaders replicate to each other. Great for multi-region writes and offline clients, but concurrent writes to the same record **conflict** and need resolution (last-write-wins, merge, CRDTs).
- **Leaderless** (Dynamo, Cassandra, Riak): clients write to several replicas directly. With **N** replicas, write to **W**, read from **R**; if **R + W > N**, every read overlaps the latest write. Read repair and anti-entropy fix stragglers.

## Partitioning (preview)

Replication copies **the same data** to more machines; **partitioning** (sharding) splits **different data** across machines. Replication scales reads and availability; partitioning scales writes and storage. Real systems do both: each partition is itself replicated. Next lesson goes deep on sharding.

Two simpler forms first:
- **Vertical partitioning**: move different tables (or columns) to different databases, e.g. users DB vs. orders DB. This is often the first split.
- **Functional partitioning** follows service boundaries (Week 9–10).

> **Numbers** Replication lag within a region is typically < 100 ms; cross-region 100 ms–1 s+. A replica that can't keep up with the leader's write volume falls further behind forever. Replicas need the same write capacity as the leader.

> **Interview** "Reads go to replicas, writes to the primary. For read-after-write consistency on a user's own data, we route that user's reads to the primary for a few seconds after they write." That one sentence shows you know the trap.

## The lab

A read-heavy API (95% reads, 6,000 rps) is drowning its primary. Add read replicas. Then, halfway through, **the primary dies**. Configure things so the system survives with high availability.
`,
      quiz: [
        { q: 'Synchronous replication to a single replica. The replica crashes. What happens to writes?', options: ['They continue at full speed', 'They block or fail until the replica returns or is removed from the sync set', 'They go to the replica', 'Nothing; sync only affects reads'], answer: 1, why: 'A sync write needs every sync replica to ack. That is why semi-sync (any one of several replicas) is common.' },
        { q: 'N = 3 replicas. Which (W, R) combination guarantees reads see the latest acknowledged write?', options: ['W=1, R=1', 'W=1, R=2', 'W=2, R=2', 'W=2, R=1'], answer: 2, why: 'R + W > N (2 + 2 > 3) forces the read set and write set to overlap in at least one replica.' },
      ],
      lab: {
        title: 'Scale reads, survive the primary',
        brief: `**6,000 rps**, 95% reads. One M-size primary is saturated.

1. Add **Read Replicas**. Connect **SQL Primary → Replica** (replication stream) and **App → Replica** (reads).
2. At **40 s** the primary dies. With **automatic failover** a replica is promoted after ~15 s; writes fail in the meantime.

Pass with availability ≥ **98%**, p99 under **400 ms** at the end, stale reads under **2%**, and cost under $2,100/month.`,
        duration: 90,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 6000, readRatio: 0.95, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 18 }],
          ['db', 'sqldb', X(3), Y(1), { size: 'M', autoFailover: false }],
        ], ['u>lb', 'lb>app', 'app>db']),
        events: [{ at: 40, do: 'kill', target: 'db' }],
        goals: [
          { metric: 'availability', op: '>=', value: 0.98, label: 'Availability ≥ 98% over the run', at: 'end' },
          { metric: 'p99', op: '<', value: 400, label: 'p99 under 400 ms at the end', at: 'end' },
          { metric: 'staleRate', op: '<', value: 0.02, label: 'Stale reads under 2%', after: 6 },
          { metric: 'cost', op: '<', value: 2100, label: 'Cost under $2,100/month', after: 0 },
        ],
        hints: [
          'Reads: 5,700/s. A replica (M = 3k units) also spends capacity replaying writes (300 writes × 2 = 600 units). Three replicas each run at ~83%.',
          'Turn on **Automatic failover** on the primary. Without it, every write fails from 40 s until the end of the run.',
          'After failover one replica becomes the new primary, so the rest absorb all reads. With 3 replicas, the 2 survivors run above 100% and lag forever. Plan N+1: **4 replicas**.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 6000, readRatio: 0.95, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 18 }],
          ['db', 'sqldb', X(3), Y(0), { size: 'M', autoFailover: true }],
          ['r1', 'replica', X(4), Y(0.5), { size: 'M' }, 'Replica 1'],
          ['r2', 'replica', X(4), Y(1.5), { size: 'M' }, 'Replica 2'],
          ['r3', 'replica', X(4), Y(2.5), { size: 'M' }, 'Replica 3'],
          ['r4', 'replica', X(4), Y(3.5), { size: 'M' }, 'Replica 4'],
        ], ['u>lb', 'lb>app', 'app>db', 'app>r1', 'app>r2', 'app>r3', 'app>r4', 'db>r1', 'db>r2', 'db>r3', 'db>r4']),
        debrief: 'Replicas scaled reads roughly linearly and gave you something to fail over to. Notice the costs: every replica replays every write (so replicas don’t help write-heavy loads), failover took ~15 s of failed writes, and async replication may have lost the last moments of writes. Check the event log.',
      },
    },

    // ------------------------------------------------------------------
    {
      id: 'sharding',
      title: 'Sharding',
      minutes: 30,
      summary: 'When one primary cannot take the writes, split the data across many databases. The shard key you pick decides whether load spreads evenly or melts one machine.',
      body: `
## The idea

**Sharding** (horizontal partitioning) splits rows across N independent databases, each owning a subset of keys. Each shard has its own primary (and replicas), so write capacity and storage scale with N.

## Choosing a partitioning scheme

**Range partitioning**: shard 1 holds keys A–F, shard 2 G–M, … (or dates, IDs).
- ✅ Range scans are efficient (all of March is on one shard).
- ❌ **Hot spots**: if the key is monotonic (auto-increment IDs, timestamps), *every* new write goes to the last shard. Classic mistake.

**Hash partitioning**: \`shard = hash(key) mod N\`.
- ✅ Spreads keys evenly.
- ❌ Range queries must hit every shard (scatter–gather).
- ❌ **Changing N remaps almost every key**: going from 4 to 5 shards moves ~80% of the data.

**Consistent hashing**: place shards (as many **virtual nodes**) on a hash ring; a key belongs to the next node clockwise. Adding a node moves only the keys in the ring segments it takes over: **~1/N of the data**. Used by DynamoDB, Cassandra, Riak, and many caches. Virtual nodes smooth out unevenness and let bigger machines take more segments.

**Directory / lookup-based**: a mapping service says which shard holds which key (or tenant). Maximum flexibility (move a hot tenant to its own shard), at the cost of an extra lookup and a critical metadata service.

**Geo-partitioning**: EU users' data in EU shards: latency and data-residency laws (GDPR).

## Picking the shard key

The shard key should:
1. Have **high cardinality** (many distinct values).
2. Spread **load**, not just data, evenly.
3. Match the **dominant access pattern**, so most queries hit **one** shard. E.g. shard chat messages by \`conversation_id\`, orders by \`customer_id\`, a SaaS app by \`tenant_id\`.

### Hot keys

Even with perfect hashing, one key can be hot: a celebrity's profile, a viral post, a mega-tenant. Mitigations: **cache** it, **salt** the key (\`post:123#0..9\`, spread over 10 sub-keys, aggregate on read), give the tenant a **dedicated shard**, or replicate hot partitions.

## What sharding costs you

- **Cross-shard queries** become scatter–gather: slower, and tail latency is the slowest shard.
- **Cross-shard transactions** need two-phase commit or sagas; most teams design to avoid them.
- **Joins** across shards move into the application.
- **Unique constraints and global IDs** need coordination (Snowflake-style IDs embed time + machine + sequence; Instagram embedded the shard ID in the photo ID).
- **Resharding** is an operational project: double-writes, backfills, cutovers. Tools: Vitess (MySQL), Citus (Postgres), or managed stores that rebalance for you.

> **Key idea** Shard as late as you can, but choose a shard key early. A key that keeps one user's (or tenant's) data together keeps 95% of queries single-shard.

> **Interview** Say: the shard key, why it spreads load, which queries become cross-shard and how you handle them, and how you'd reshard (consistent hashing, or many logical shards mapped onto fewer physical hosts so you move whole logical shards).

## The lab

An orders database takes **3,000 writes/s** plus 3,000 reads/s, far beyond one primary. The team sharded it, but by **range on order ID**, so every new order lands on the newest shard. Fix the partitioning and size the cluster.
`,
      quiz: [
        { q: 'Orders are range-sharded by auto-increment order_id. What goes wrong?', options: ['Reads become cross-shard', 'All new inserts hit the last shard, which becomes a hot spot', 'Order IDs collide', 'Nothing; range sharding balances automatically'], answer: 1, why: 'Monotonic keys map every new write to the highest range: one hot shard, N−1 idle ones.' },
        { q: 'You go from 10 to 11 shards using hash(key) mod N. Roughly how much data moves?', options: ['~9%', '~50%', '~91%', '0%'], answer: 2, why: 'With mod-N, a key stays only if hash mod 10 == hash mod 11, which is true for ~1/11 of keys. Consistent hashing would move only ~1/11.' },
        { q: 'Best shard key for a multi-tenant B2B SaaS where every query is scoped to one tenant?', options: ['created_at', 'tenant_id (with a plan for very large tenants)', 'A random UUID per row', 'Country'], answer: 1, why: 'tenant_id keeps each tenant’s queries on one shard. Giant tenants may need a dedicated shard or sub-partitioning.' },
      ],
      lab: {
        title: 'Unmelt the hot shard',
        brief: `**6,000 rps**, half writes. A single primary would need ~15k work units/s.

The cluster has 4 shards partitioned by **range** on a time-ordered order ID, so one shard takes almost every write. Change the partitioning to spread load, and add enough shards that each runs comfortably.

Goals: errors under 1%, p99 under 300 ms, cost under $3,000/month.`,
        duration: 50,
        graph: G([
          ['u', 'client', X(0), Y(1), { rps: 6000, readRatio: 0.5, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 18 }, 'Orders API'],
          ['db', 'shard', X(3), Y(1), { shards: 4, partitioning: 'range' }, 'Orders DB'],
        ], ['u>lb', 'lb>app', 'app>db']),
        goals: [
          { metric: 'errRate', op: '<', value: 0.01, label: 'Errors under 1%', after: 8 },
          { metric: 'p99', op: '<', value: 300, label: 'p99 under 300 ms', after: 8 },
          { metric: 'cost', op: '<', value: 3000, label: 'Cost under $3,000/month', after: 0 },
        ],
        hints: [
          'Switch partitioning to **consistent-hash** so writes spread across all shards.',
          'Total work ≈ 3,000 reads + 3,000 writes × 4 = 15k units. Each shard does 3k. At ~65% utilization that’s ~8 shards.',
        ],
        solution: G([
          ['u', 'client', X(0), Y(1), { rps: 6000, readRatio: 0.5, rttMs: 50 }],
          ['lb', 'lb', X(1), Y(1)],
          ['app', 'app', X(2), Y(1), { instances: 18 }, 'Orders API'],
          ['db', 'shard', X(3), Y(1), { shards: 8, partitioning: 'consistent-hash' }, 'Orders DB'],
        ], ['u>lb', 'lb>app', 'app>db']),
        debrief: 'The shard key and scheme matter more than the shard count: 4 range shards had one at 100% and three idle. Try changing the shard count **while the simulation runs**: with hash-mod-n, going 8 → 9 moves almost every key and the migration load can tip shards over; with consistent hashing only ~1/9 moves.',
      },
    },
  ],
};
