// Component catalog: every building block the user can drag onto the canvas.
// Capacities are in "work units / second"; a plain dynamic request costs 1 unit.

export const REGIONS = ['us-east', 'us-west', 'eu-west'];

// Compute instances (app servers, workers). Vertical scaling is deliberately
// super-linear in price so horizontal scaling wins at scale.
export const COMPUTE_SIZES = {
  S: { cap: 500, threads: 100, cost: 40 },
  M: { cap: 1000, threads: 200, cost: 85 },
  L: { cap: 2000, threads: 400, cost: 180 },
  XL: { cap: 4000, threads: 800, cost: 400 },
};

// Relational database instances.
export const DB_SIZES = {
  S: { cap: 1500, cost: 120 },
  M: { cap: 3000, cost: 260 },
  L: { cap: 6000, cost: 560 },
  XL: { cap: 12000, cost: 1200 },
};

const SIZE_KEYS = Object.keys(COMPUTE_SIZES);
const region = { key: 'region', label: 'Region', kind: 'select', options: REGIONS, default: 'us-east', help: 'Used by region-outage drills. Nodes in a failed region all go down together.' };

const autoscaleParams = [
  { key: 'autoscale', label: 'Autoscaling', kind: 'toggle', default: false, help: 'Add/remove instances to hold CPU near the target. New instances take time to boot.' },
  { key: 'minInstances', label: 'Min instances', kind: 'number', min: 1, max: 200, step: 1, default: 2, showIf: p => p.autoscale },
  { key: 'maxInstances', label: 'Max instances', kind: 'number', min: 1, max: 200, step: 1, default: 20, showIf: p => p.autoscale },
  { key: 'targetCpu', label: 'Target CPU %', kind: 'range', min: 30, max: 90, step: 5, default: 60, showIf: p => p.autoscale },
  { key: 'bootSec', label: 'Boot time (s)', kind: 'number', min: 0, max: 120, step: 5, default: 20, showIf: p => p.autoscale },
];

const resilienceParams = [
  { key: 'timeoutMs', label: 'Downstream timeout (ms)', kind: 'number', min: 0, max: 30000, step: 50, default: 0, help: '0 = no timeout. Without a timeout, a slow dependency holds threads until the pool is exhausted.' },
  { key: 'retries', label: 'Retries per call', kind: 'number', min: 0, max: 5, step: 1, default: 0, help: 'Each failed attempt is retried. Retries multiply load on a struggling dependency.' },
  { key: 'backoff', label: 'Exponential backoff + jitter', kind: 'toggle', default: true, showIf: p => p.retries > 0 },
  { key: 'circuitBreaker', label: 'Circuit breaker', kind: 'toggle', default: false, help: 'Stop calling a dependency that is failing >50% for 1s. Probe again after 5s.' },
  { key: 'fallback', label: 'Fallback when open', kind: 'toggle', default: false, showIf: p => p.circuitBreaker, help: 'Serve a degraded response (cached/default) instead of an error.' },
  { key: 'idempotency', label: 'Idempotency keys', kind: 'toggle', default: false, help: 'Retried writes carry a key so the server de-duplicates them.' },
];

export const CATALOG = {
  client: {
    label: 'Users', icon: '👥', category: 'Traffic', color: '#94a3b8',
    desc: 'A population of users sending requests. Reads, writes and static asset downloads.',
    params: [
      { key: 'rps', label: 'Requests / sec', kind: 'number', min: 0, max: 5000000, step: 100, default: 600 },
      { key: 'pattern', label: 'Traffic pattern', kind: 'select', options: ['steady', 'diurnal', 'spiky', 'ramp'], default: 'steady', help: 'diurnal: ±50% wave; spiky: 4× bursts every 30s; ramp: 0.25× → 3× over two minutes.' },
      { key: 'readRatio', label: 'Read share', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.9 },
      { key: 'staticRatio', label: 'Static assets (share of reads)', kind: 'range', min: 0, max: 1, step: 0.01, default: 0, help: 'Images, JS, video chunks. Perfect for a CDN.' },
      { key: 'staticKB', label: 'Avg asset size (KB)', kind: 'number', min: 1, max: 100000, step: 10, default: 200, showIf: p => p.staticRatio > 0 },
      { key: 'workingSetGB', label: 'Hot data size (GB)', kind: 'number', min: 1, max: 100000, step: 1, default: 20, help: 'How much data is frequently read. Caches smaller than this miss more.' },
      { key: 'rttMs', label: 'Network RTT to origin (ms)', kind: 'number', min: 1, max: 400, step: 5, default: 80 },
      { key: 'timeoutMs', label: 'Client timeout (ms)', kind: 'number', min: 0, max: 30000, step: 100, default: 3000 },
      { key: 'retries', label: 'Client retries', kind: 'number', min: 0, max: 5, step: 1, default: 1 },
      { key: 'backoff', label: 'Exponential backoff + jitter', kind: 'toggle', default: true, showIf: p => p.retries > 0 },
      { key: 'idempotency', label: 'Idempotency keys', kind: 'toggle', default: false },
    ],
    cost: () => 0,
  },
  dns: {
    label: 'DNS', icon: '🧭', category: 'Edge', color: '#22d3ee',
    desc: 'Resolves a hostname to an endpoint. With health checks it can fail over between regions.',
    params: [
      { key: 'mode', label: 'Routing', kind: 'select', options: ['failover', 'round-robin', 'latency'], default: 'failover', help: 'failover: all traffic to the first healthy target; round-robin: spread evenly; latency: prefer the fastest target.' },
      { key: 'healthChecks', label: 'Health checks', kind: 'toggle', default: true },
      { key: 'ttl', label: 'Record TTL (s)', kind: 'number', min: 5, max: 86400, step: 5, default: 60, help: 'After a failover, clients keep using the old answer for up to one TTL.' },
    ],
    cost: () => 5,
  },
  cdn: {
    label: 'CDN', icon: '🌐', category: 'Edge', color: '#38bdf8',
    desc: 'Edge caches near users. Serves static assets (and optionally cacheable API responses) without touching your origin.',
    params: [
      { key: 'staticHit', label: 'Static hit ratio', kind: 'range', min: 0, max: 0.99, step: 0.01, default: 0.95 },
      { key: 'cacheApi', label: 'Cache API GETs at edge', kind: 'toggle', default: false, help: 'Only works for responses that are the same for everyone (public, short TTL).' },
      { key: 'apiHit', label: 'API hit ratio', kind: 'range', min: 0, max: 0.95, step: 0.01, default: 0.5, showIf: p => p.cacheApi },
      { key: 'originRttMs', label: 'Edge → origin RTT (ms)', kind: 'number', min: 1, max: 300, step: 5, default: 70 },
    ],
    cost: () => 20,
  },
  lb: {
    label: 'Load Balancer', icon: '⚖️', category: 'Edge', color: '#34d399',
    desc: 'Spreads requests across servers. Health checks stop it from sending traffic to dead servers.',
    params: [
      { key: 'algorithm', label: 'Algorithm', kind: 'select', options: ['round-robin', 'least-connections', 'random'], default: 'round-robin' },
      { key: 'healthChecks', label: 'Health checks', kind: 'toggle', default: true },
      { key: 'outlierDetection', label: 'Outlier detection', kind: 'toggle', default: false, help: 'Eject targets whose latency is >3× the median of their peers. Catches "gray failures" that still pass health checks.' },
      { key: 'instances', label: 'LB instances', kind: 'number', min: 1, max: 10, step: 1, default: 1, help: 'Each handles ~20k rps.' },
      region,
    ],
    cost: p => 25 * p.instances,
  },
  gateway: {
    label: 'API Gateway', icon: '🚦', category: 'Edge', color: '#a3e635',
    desc: 'Front door for APIs: authentication, routing and rate limiting. Excess traffic gets HTTP 429.',
    params: [
      { key: 'rateLimit', label: 'Rate limiting', kind: 'toggle', default: true },
      { key: 'limitRps', label: 'Limit (req/s)', kind: 'number', min: 1, max: 1000000, step: 100, default: 5000, showIf: p => p.rateLimit },
      { key: 'algorithm', label: 'Algorithm', kind: 'select', options: ['token-bucket', 'leaky-bucket', 'fixed-window'], default: 'token-bucket', showIf: p => p.rateLimit, help: 'token-bucket: allows bursts up to the bucket size, rejects the rest. leaky-bucket: queues and smooths, adding latency. fixed-window: counter per second, allows 2× bursts at window edges.' },
      { key: 'burst', label: 'Burst size', kind: 'number', min: 0, max: 1000000, step: 100, default: 2000, showIf: p => p.rateLimit && p.algorithm !== 'fixed-window' },
      { key: 'instances', label: 'Instances', kind: 'number', min: 1, max: 20, step: 1, default: 1, help: 'Each handles ~20k rps.' },
      region,
    ],
    cost: p => 45 * p.instances,
  },
  app: {
    label: 'App Server', icon: '🖥️', category: 'Compute', color: '#f59e0b',
    desc: 'Stateless service running your business logic. Scale out with more instances or up with bigger ones.',
    params: [
      { key: 'instances', label: 'Instances', kind: 'number', min: 1, max: 200, step: 1, default: 2 },
      { key: 'size', label: 'Instance size', kind: 'select', options: SIZE_KEYS, default: 'S', help: 'S=500 rps, M=1k, L=2k, XL=4k CPU capacity. Bigger costs more per rps.' },
      { key: 'baseMs', label: 'Service time (ms)', kind: 'number', min: 1, max: 2000, step: 1, default: 15 },
      ...autoscaleParams,
      ...resilienceParams,
      { key: 'readYourWrites', label: 'Read-your-writes routing', kind: 'toggle', default: false, help: 'Send reads that follow a user\'s own write to the primary, so they never see stale data from a lagging replica.' },
      region,
    ],
    cost: p => COMPUTE_SIZES[p.size].cost * p.instances,
  },
  worker: {
    label: 'Worker', icon: '⚙️', category: 'Compute', color: '#fb923c',
    desc: 'Consumes messages from a queue and does the slow or async work (writes, fan-out, notifications).',
    params: [
      { key: 'instances', label: 'Consumers', kind: 'number', min: 1, max: 200, step: 1, default: 2 },
      { key: 'size', label: 'Instance size', kind: 'select', options: SIZE_KEYS, default: 'S' },
      { key: 'baseMs', label: 'Processing time (ms)', kind: 'number', min: 1, max: 5000, step: 1, default: 25 },
      ...autoscaleParams,
      ...resilienceParams.filter(x => x.key !== 'fallback' && x.key !== 'circuitBreaker'),
      region,
    ],
    cost: p => COMPUTE_SIZES[p.size].cost * p.instances,
  },
  cache: {
    label: 'Cache (Redis)', icon: '⚡', category: 'Data', color: '#ef4444',
    desc: 'In-memory key-value store. Sub-millisecond reads that shield the database.',
    params: [
      { key: 'memoryGB', label: 'Memory (GB)', kind: 'select', options: [4, 8, 16, 32, 64, 128], default: 16, help: 'Hit ratio depends on memory relative to the hot data size.' },
      { key: 'ttlSec', label: 'TTL (s)', kind: 'number', min: 1, max: 86400, step: 1, default: 300, help: 'Longer TTL = more hits but staler data.' },
      { key: 'strategy', label: 'Write strategy', kind: 'select', options: ['cache-aside', 'write-through', 'write-back'], default: 'cache-aside', help: 'cache-aside: app writes DB and invalidates. write-through: writes go through the cache to the DB. write-back: cache acks, flushes to DB later in batches.' },
      { key: 'coalescing', label: 'Request coalescing', kind: 'toggle', default: false, help: 'On a miss, only one request rebuilds a key; others wait. Prevents cache stampedes.' },
      { key: 'nodes', label: 'Cluster nodes', kind: 'number', min: 1, max: 30, step: 1, default: 1, help: 'Each node handles ~100k ops/s.' },
      region,
    ],
    cost: p => p.nodes * p.memoryGB * 7.5,
  },
  sqldb: {
    label: 'SQL Primary', icon: '🗄️', category: 'Data', color: '#6366f1',
    desc: 'Relational database (Postgres/MySQL). ACID transactions, joins, single writer.',
    params: [
      { key: 'size', label: 'Instance size', kind: 'select', options: SIZE_KEYS, default: 'M', help: 'S=1.5k, M=3k, L=6k, XL=12k work units/s. A read costs 1, a write 4.' },
      { key: 'indexed', label: 'Queries use indexes', kind: 'toggle', default: true, help: 'Without an index every read is a scan: about 15× the cost.' },
      { key: 'isolation', label: 'Isolation level', kind: 'select', options: ['read-committed', 'repeatable-read', 'serializable'], default: 'read-committed', help: 'Stronger isolation = more locking/aborts = lower write throughput.' },
      { key: 'replication', label: 'Replication', kind: 'select', options: ['async', 'sync'], default: 'async', help: 'sync: a write commits only when replicas confirm it (no data loss, slower, blocked if a replica is unreachable).' },
      { key: 'autoFailover', label: 'Automatic failover', kind: 'toggle', default: true, help: 'If the primary dies, promote a replica after ~15s.' },
      region,
    ],
    cost: p => DB_SIZES[p.size].cost,
  },
  replica: {
    label: 'Read Replica', icon: '📚', category: 'Data', color: '#818cf8',
    desc: 'Copy of the primary that serves reads. Connect primary → replica for replication and app → replica for reads.',
    params: [
      { key: 'size', label: 'Instance size', kind: 'select', options: SIZE_KEYS, default: 'M' },
      region,
    ],
    cost: p => DB_SIZES[p.size].cost,
  },
  nosql: {
    label: 'NoSQL (Cassandra)', icon: '🧱', category: 'Data', color: '#a855f7',
    desc: 'Leaderless wide-column store. Scales writes horizontally. Tunable consistency per request.',
    params: [
      { key: 'nodes', label: 'Nodes', kind: 'number', min: 1, max: 100, step: 1, default: 6, help: 'Each node handles ~5k work units/s.' },
      { key: 'rf', label: 'Replication factor', kind: 'number', min: 1, max: 5, step: 1, default: 3 },
      { key: 'consistency', label: 'Consistency level', kind: 'select', options: ['ONE', 'QUORUM', 'ALL'], default: 'QUORUM', help: 'How many replicas must answer. QUORUM reads + QUORUM writes overlap, so reads are strongly consistent.' },
      { key: 'hotKeySkew', label: 'Hot-key skew', kind: 'range', min: 0, max: 0.9, step: 0.05, default: 0, help: 'Share of traffic hitting one partition key (a celebrity, a viral post).' },
      region,
    ],
    cost: p => p.nodes * 220,
  },
  shard: {
    label: 'Sharded SQL', icon: '🧩', category: 'Data', color: '#8b5cf6',
    desc: 'Many SQL databases, each owning a slice of the keys. Scales writes, complicates everything else.',
    params: [
      { key: 'shards', label: 'Shards', kind: 'number', min: 1, max: 256, step: 1, default: 4, help: 'Each shard is an M-size DB (3k units/s).' },
      { key: 'partitioning', label: 'Partitioning', kind: 'select', options: ['consistent-hash', 'hash-mod-n', 'range'], default: 'consistent-hash', help: 'hash-mod-n moves most keys when the shard count changes. consistent-hash moves ~1/N. range on time-ordered keys sends every new write to the last shard.' },
      { key: 'hotKeySkew', label: 'Hot-key skew', kind: 'range', min: 0, max: 0.9, step: 0.05, default: 0 },
      region,
    ],
    cost: p => p.shards * DB_SIZES.M.cost,
  },
  queue: {
    label: 'Queue (Kafka)', icon: '📨', category: 'Messaging', color: '#14b8a6',
    desc: 'Durable log. Producers append, consumers read at their own pace. Absorbs spikes, decouples services.',
    params: [
      { key: 'partitions', label: 'Partitions', kind: 'number', min: 1, max: 512, step: 1, default: 6, help: 'Max parallelism per consumer group. Each partition ingests ~5k msg/s.' },
      { key: 'mode', label: 'Delivery', kind: 'select', options: ['competing-consumers', 'pub-sub'], default: 'competing-consumers', help: 'competing: each message goes to one worker. pub-sub: every connected worker group gets every message.' },
      { key: 'maxBacklogM', label: 'Retention (M messages)', kind: 'number', min: 0.1, max: 10000, step: 0.1, default: 100 },
      region,
    ],
    cost: p => 150 + 12 * p.partitions,
  },
  blob: {
    label: 'Object Storage', icon: '🪣', category: 'Data', color: '#eab308',
    desc: 'S3-style blob store for images, video and backups. Effectively unlimited capacity, higher latency.',
    params: [region],
    cost: () => 50,
  },
  external: {
    label: 'External API', icon: '🔌', category: 'Messaging', color: '#f472b6',
    desc: 'A third-party dependency you do not control (payment processor, APNs/FCM, SMS). Has quotas, latency and failures.',
    params: [
      { key: 'latencyMs', label: 'Latency (ms)', kind: 'number', min: 1, max: 10000, step: 10, default: 250 },
      { key: 'quotaRps', label: 'Quota (req/s)', kind: 'number', min: 1, max: 1000000, step: 100, default: 2000 },
      { key: 'errorRate', label: 'Baseline error rate', kind: 'range', min: 0, max: 0.5, step: 0.005, default: 0.005 },
      { key: 'invokedFor', label: 'Called for', kind: 'select', options: ['writes', 'all'], default: 'writes' },
    ],
    cost: () => 0,
  },
};

export const CATEGORIES = ['Traffic', 'Edge', 'Compute', 'Data', 'Messaging'];

export function defaultParams(type) {
  const out = {};
  for (const p of CATALOG[type].params) out[p.key] = p.default;
  return out;
}

export function withDefaults(type, params = {}) {
  return { ...defaultParams(type), ...params };
}

export function nodeCost(node, liveInstances) {
  const def = CATALOG[node.type];
  if (!def) return 0;
  const p = liveInstances != null ? { ...node.params, instances: liveInstances } : node.params;
  return def.cost(p);
}
