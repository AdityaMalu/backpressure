# Backpressure

**Learn system design by breaking things.** A free 12-week course with a live traffic simulator. Every lesson explains a concept in depth, then drops you into a lab: build the architecture with drag and drop, push traffic through it, inject failures, and hold the goals (latency, errors, cost) for the whole run.

- 29 lessons across 6 modules: fundamentals, databases, caching & traffic, distributed systems, architecture & reliability, and 7 real-world designs (URL shortener, WhatsApp, Instagram, YouTube, Uber, payments, notifications).
- Free-form canvas: 15 component types (load balancers, gateways, app servers, workers, Redis, SQL primaries and replicas, Cassandra, sharded SQL, Kafka, CDN, DNS, object storage, third-party APIs).
- A queueing-based simulator that models utilization knees, thread-pool exhaustion (Little's law), retry storms, timeouts, circuit breakers, cache stampedes, replication lag, failover and data loss, hot partitions, resharding, consumer lag, CAP behaviour during partitions, autoscaling lag, CDN egress cost and more.
- Diagnostics that explain what's breaking and why, plus metrics charts, an event log and a request-trace waterfall.
- Sandbox mode with templates, undo/redo, JSON import/export and share links (the design is compressed into the URL).

No build step and no dependencies: plain ES modules, HTML and CSS.

## Run locally

```bash
python serve.py 8781
```

Then open http://localhost:8781. Any static file server works; `serve.py` just disables caching so edits show up on reload.

## Deploy

It's a static site. Copy the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages, S3). For GitHub Pages, push the folder to a repo and enable Pages on the branch. No configuration is needed.

## Project layout

```
index.html            shell
css/app.css           all styles (dark theme, responsive)
js/main.js            app glue: routing, run loop, panels, goals, modals
js/engine.js          the simulator (forward/backward pass per 100 ms tick)
js/catalog.js         component types, parameters, capacities and prices
js/editor.js          drag-and-drop canvas, wiring, traffic particles, callouts
js/insights.js        turns simulator state into explanations and fixes
js/curriculum/*.js    lessons: markdown body, quiz, lab (graph, events, goals, hints, solution)
js/selftest.js        lab calibration checks
```

## Adding or changing a lesson

Each lesson lives in `js/curriculum/wNN-*.js`:

```js
{
  id: 'my-lesson', title: '…', minutes: 20, summary: '…',
  body: `markdown…`,
  quiz: [{ q, options: [...], answer: 1, why }],
  lab: {
    brief: `markdown…`, duration: 60,
    graph: G([[id, type, x, y, params, label], …], ['from>to', …]),
    events: [{ at: 20, do: 'kill' | 'restore' | 'slow' | 'unslow' | 'spike' | 'partition' | 'heal' | 'region' | 'failNode', target }],
    goals: [{ metric: 'p99' | 'errRate' | 'availability' | 'cost' | 'avgCost' | 'staleRate' | 'consumerLag' | 'duplicates' | 'lostWrites' | …, op: '<', value, at?: 'end', after? }],
    hints: [...], solution: G(...), debrief: '…',
  },
}
```

After changing the engine or any lab, run the calibration suite in the browser console:

```js
(await import('/js/selftest.js')).runAll()
```

Every lab must satisfy two checks: the **starter design fails** and the **reference solution passes**. `timeline(id)` prints a second-by-second trace of a lab run for debugging.

CI runs the same suite on every push and pull request (`.github/workflows/selftest.yml`). With Node installed you can run it locally too: `node tools/selftest-node.mjs [lesson-id-filter]`.

## Accuracy

Numbers are realistic approximations chosen for teaching: instance capacities, latencies and prices are in the right order of magnitude, and the dynamics (queueing, retries, failover, lag) behave like real systems. They are not benchmarks of any specific product.
