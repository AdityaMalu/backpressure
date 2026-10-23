// Turns raw simulator state into human explanations: what is breaking, why,
// and what a senior engineer would try next. This is the teaching layer.

import { nm } from './engine.js';

const ms = x => (x >= 1000 ? (x / 1000).toFixed(1) + 's' : Math.round(x) + 'ms');
const pct = x => (x * 100 >= 10 ? Math.round(x * 100) : (x * 100).toFixed(1)) + '%';
const rps = x => (x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : Math.round(x)) + ' rps';

export function diagnose(sim) {
  const out = [];
  const push = (n, sev, title, text, fix) => out.push({ node: n ? n.id : null, sev, title, text, fix });
  const g = sim.graph;
  const tot = f => f.r + f.w + f.s;

  for (const n of g.nodes) {
    const st = sim.ns.get(n.id);
    if (!st) continue;
    const p = n.params;
    const load = tot(st.in);

    if (n.type === 'client') {
      if (!sim.outEdges(n).length && load > 0) push(n, 'bad', 'Users have nowhere to go', 'Every request fails: nothing is connected to the users.', 'Drag from the right edge of Users to a load balancer or server.');
      continue;
    }
    if (st.down) {
      if (load > 0 || st.inRepl > 0) push(n, 'bad', `${nm(n)} is down`, `${rps(load)} is still being sent to a dead component.`, n.type === 'sqldb' ? 'Add a replica with automatic failover, or restore it.' : 'Add redundancy behind a load balancer with health checks.');
      continue;
    }

    // Upstream LB still routing to a dead node
    if (n.type === 'lb' && !p.healthChecks) {
      const dead = sim.outs(n).filter(x => sim.ns.get(x.t.id)?.down);
      if (dead.length) push(n, 'bad', 'Routing traffic to a dead server', `No health checks: ~${pct(dead.length / sim.outs(n).length)} of requests go to ${dead.map(x => nm(x.t)).join(', ')} and fail.`, 'Enable health checks so the LB ejects failed targets within seconds.');
    }
    if (n.type === 'lb' && st.ejected > 0) push(n, 'good', 'Outlier ejected', `${st.ejected} target(s) were much slower than their peers and have been taken out of rotation.`, '');
    if (n.type === 'lb' && st.noTargets && load > 0) push(n, 'bad', 'No healthy targets', 'All servers behind this load balancer are down or failing health checks.', 'Add more instances / another zone.');

    if (n.type === 'app' || n.type === 'worker') {
      const threadBound = st.threadUtil > 0.95 && st.threadUtil > st.cpu + 0.15;
      if (threadBound) push(n, 'bad', 'Thread pool exhausted', `Requests hold threads for ~${ms(st.holdMs)} waiting on a slow dependency, so capacity collapses (Little's law: throughput = threads ÷ time held). CPU is only ${pct(st.cpu)}.`, p.timeoutMs ? 'Fix or isolate the slow dependency (circuit breaker, bulkhead) or lower the timeout.' : 'Set a downstream timeout and add a circuit breaker so a slow dependency cannot take you down.');
      else if (st.util >= 0.95 || st.dropFrac > 0.01) push(n, 'bad', `${n.type === 'worker' ? 'Workers' : 'Servers'} saturated`, `CPU ${pct(st.cpu)}, ${rps(load)} in vs ~${rps(st.effCap)} capacity. ${st.dropFrac > 0.01 ? pct(st.dropFrac) + ' of requests are being dropped.' : 'Requests are queuing.'}`, p.autoscale ? `Autoscaling is on. ${st.pending.length ? st.pending.length + ' instance(s) still booting.' : 'Raise max instances.'}` : 'Add instances (horizontal), pick a bigger size (vertical), or enable autoscaling. Caching upstream also cuts load.');
      else if (st.util >= 0.7) push(n, 'warn', 'Running hot', `Utilization ${pct(Math.max(st.cpu, st.threadUtil))}. Latency rises sharply above ~70% (queueing).`, 'Keep headroom for spikes: target 50–70%.');
      if (st.pending.length) push(n, 'info', 'Scaling out', `${st.pending.length} instance(s) booting. Autoscaling reacts, but not instantly.`, 'Pre-scale for known peaks, keep warm pools, or reduce boot time.');
    }

    if (n.type === 'sqldb' || n.type === 'replica') {
      if (st.util >= 0.95 || st.dropFrac > 0.01) {
        const readHeavy = n.type === 'replica' || (st.readWork || 0) > (st.writeWork || 0);
        push(n, 'bad', 'Database saturation', `Queries queue faster than they drain. p99 ${ms(st.lat.r.p99 || st.lat.w.p99)}.`,
          n.type === 'replica' ? 'Add more replicas or a cache in front.' :
          !p.indexed ? 'Add an index: unindexed reads cost ~15× each.' :
          readHeavy ? 'Reads dominate: add a cache (cache-aside) and/or read replicas.' : 'Writes dominate: batch them through a queue, shard the data, or move to a write-scalable store.');
      } else if (st.util >= 0.7) push(n, 'warn', 'Database running hot', `Utilization ${pct(st.util)}.`, 'Databases are the hardest tier to scale, so act before it saturates.');
      if (n.type === 'sqldb' && !p.indexed && st.in.r > 0) push(n, 'warn', 'Full table scans', 'Queries are not using an index, so each read scans the table.', 'Toggle "Queries use indexes".');
      if (n.type === 'sqldb' && st.syncBlocked) push(n, 'bad', 'Writes blocked by sync replication', 'Synchronous replication waits for every replica. One is unreachable, so writes cannot commit.', 'Use semi-sync (one replica ack) or async, accepting a small data-loss window.');
      if (n.type === 'replica' && st.lag > 1.5) push(n, 'bad', 'Replication lag', `This replica is ${st.lag.toFixed(1)}s behind the primary. Reads here return stale data (${pct(st.ownStale.r)}).`, 'Reduce write load, add read-your-writes routing, or use a bigger replica.');
      if (n.type === 'replica' && st.noPrimary) push(n, 'warn', 'Replica has no primary', 'Nothing replicates into this replica.', 'Connect SQL Primary → Read Replica.');
    }

    if (n.type === 'cache') {
      if (st.warmth < 0.9) push(n, p.coalescing ? 'warn' : 'bad', 'Cold cache', `Hit ratio is only ${pct(st.hit)} while it warms up.${p.coalescing ? '' : ` Without coalescing, concurrent misses on the same hot keys multiply DB load ×${st.stampede.toFixed(1)}: a cache stampede.`}`, p.coalescing ? 'Coalescing is limiting the stampede.' : 'Enable request coalescing (single-flight), pre-warm, or use stale-while-revalidate.');
      else if (st.hit < 0.6 && st.in.r > 0) push(n, 'warn', 'Low hit ratio', `Only ${pct(st.hit)} of reads hit. The hot set (${sim.ctx().workingSetGB}GB) doesn't fit, or the TTL is too short.`, 'Add memory/nodes or lengthen the TTL.');
      if (st.ownStale.r > 0.01) push(n, 'warn', 'Stale reads from cache', `${pct(st.ownStale.r)} of reads return outdated values (TTL ${p.ttlSec}s with cache-aside).`, 'Invalidate on write, shorten the TTL, or use write-through.');
    }

    if (n.type === 'queue') {
      if (st.qlag > 5) push(n, st.qlag > 30 ? 'bad' : 'warn', 'Consumers falling behind', `Backlog ${Math.round(st.qBacklog).toLocaleString()} messages, lag ~${ms(st.qlag * 1000)}. Producers are fine (the queue absorbs the spike), but work is delayed.`, 'Add worker instances (up to the partition count) or add partitions.');
      if (st.idleConsumers > 0) push(n, 'warn', 'Idle consumers', `${st.idleConsumers} consumer(s) are idle: a partition can only be read by one consumer per group (${p.partitions} partitions).`, 'Increase partitions to scale consumers further.');
      if (st.redeliver > 1) push(n, 'warn', 'Redeliveries', `${rps(st.redeliver)} of messages failed in workers and are being redelivered (at-least-once).`, 'Make consumers idempotent, and route poison messages to a dead-letter queue.');
      if (st.dropFrac > 0.01) push(n, 'bad', 'Queue rejecting writes', 'Ingest exceeds partition throughput or retention is full.', 'Add partitions or retention.');
    }

    if (n.type === 'gateway' && st.rejFrac > 0.01) push(n, 'info', 'Rate limiter shedding load', `${pct(st.rejFrac)} of requests get HTTP 429. This protects the backend from overload.`, 'Raise the limit only if the backend can take it.');

    if ((n.type === 'shard' || n.type === 'nosql') && (st.hotShare || 0) > 1.5 / Math.max(1, (p.shards || p.nodes || 1)) && (st.util > 0.7)) push(n, 'bad', 'Hot partition', `One ${n.type === 'shard' ? 'shard' : 'node'} takes ${pct(st.hotShare)} of the traffic while the others idle.${p.partitioning === 'range' ? ' Range partitioning on time-ordered keys sends every new write to the last range.' : ''}`, p.partitioning === 'range' ? 'Hash the key instead, or prefix it with a random bucket.' : 'Split the hot key (salting), cache it, or replicate the hot partition.');
    else if ((n.type === 'shard' || n.type === 'nosql') && (st.util >= 0.95 || st.dropFrac > 0.01)) push(n, 'bad', `${n.type === 'shard' ? 'Shards' : 'Cluster'} saturated`, `Utilization ${pct(st.util)}.`, n.type === 'shard' ? 'Add shards.' : 'Add nodes.');
    if (n.type === 'shard' && st.migrating) push(n, p.partitioning === 'hash-mod-n' ? 'bad' : 'info', 'Rebalancing data', `Moving ~${pct(st.migrationFrac)} of keys between shards.`, p.partitioning === 'hash-mod-n' ? 'Consistent hashing would move only ~1/N of the keys.' : 'Consistent hashing keeps the move small.');
    if (n.type === 'nosql' && st.partitioned) push(n, p.consistency === 'ONE' ? 'warn' : 'bad', p.consistency === 'ONE' ? 'Partition: choosing Availability' : 'Partition: choosing Consistency', p.consistency === 'ONE' ? `Every request is answered, but ~${pct(st.ownStale.r)} of reads are stale (AP).` : `Requests that can't reach ${p.consistency} replicas fail (CP): ${pct(st.unavailable)} unavailable.`, 'That is the CAP trade-off: during a partition you pick one.');
    if (n.type === 'nosql' && st.unavailable > 0 && !st.partitioned) push(n, 'bad', 'Not enough replicas', `${st.failedNodes} node(s) down and consistency ${p.consistency} needs more replicas than are alive for some keys.`, 'Lower the consistency level or raise the replication factor.');
    if (n.type === 'external' && st.quotaFrac > 0.01) push(n, 'bad', 'Third-party quota exceeded', `${pct(st.quotaFrac)} of calls are rejected by the provider.`, 'Queue and smooth calls, batch them, or negotiate a higher quota.');
  }

  // Edge-level: retry storms, breakers, duplicates
  for (const e of g.edges) {
    const E = sim.es.get(e.id);
    if (!E) continue;
    const src = g.nodes.find(n => n.id === e.from);
    const tgt = g.nodes.find(n => n.id === e.to);
    if (!src || !tgt) continue;
    if (E.amp > 1.4) push(src, 'bad', 'Retry storm', `Retries are amplifying load on ${nm(tgt)} ×${E.amp.toFixed(1)}, which is already failing, so it can't recover.`, src.params.backoff ? 'Add a circuit breaker and a retry budget.' : 'Use exponential backoff with jitter, a retry budget, and a circuit breaker.');
    if (E.cb && E.cb.state !== 'closed') push(src, 'good', `Circuit ${E.cb.state === 'open' ? 'open' : 'half-open'}`, `Calls to ${nm(tgt)} ${E.cb.state === 'open' ? 'fail fast instead of waiting' : 'are being probed'}${src.params.fallback ? ' and a fallback response is served' : ''}.`, '');
    if ((E.dupRate || 0) > 0.5) push(src, 'bad', 'Duplicate writes', `~${rps(E.dupRate)} of writes time out and are retried after they already succeeded. Without idempotency keys each retry runs again (double charges, double posts).`, 'Enable idempotency keys.');
    if (E.cut) push(src, 'bad', 'Network partition', `${nm(src)} cannot reach ${nm(tgt)}.`, 'Design for it: retries to other replicas, failover, or degrade gracefully.');
  }

  // Global
  const m = sim.metrics;
  if (m.lostWrites > 0) push(null, 'bad', 'Data loss', `${Math.round(m.lostWrites).toLocaleString()} acknowledged writes were lost.`, 'Use synchronous replication / durable queues for data you cannot lose.');

  const sevRank = { bad: 0, warn: 1, good: 2, info: 3 };
  out.sort((a, b) => sevRank[a.sev] - sevRank[b.sev]);
  return out;
}
