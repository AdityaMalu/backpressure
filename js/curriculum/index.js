import { G, X, Y } from './util.js';
import w01 from './w01-fundamentals.js';
import w03 from './w03-databases.js';
import w05 from './w05-caching-traffic.js';
import w07 from './w07-distributed.js';
import w09 from './w09-architecture.js';
import w11 from './w11-designs.js';

export const COURSE = [w01, w03, w05, w07, w09, w11].map(m => ({ ...m, lessons: m.lessons.map(l => ({ ...l, week: m.week, module: m.title })) }));
export const LESSONS = COURSE.flatMap(m => m.lessons);
export const findLesson = id => LESSONS.find(l => l.id === id);

export const TEMPLATES = [
  {
    title: 'Classic three-tier web app',
    desc: 'Users → LB → stateless app → cache + primary with a read replica.',
    graph: G([
      ['u', 'client', X(0), Y(1), { rps: 3000, readRatio: 0.9 }],
      ['lb', 'lb', X(1), Y(1)],
      ['app', 'app', X(2), Y(1), { instances: 6 }],
      ['cache', 'cache', X(3), Y(0)],
      ['db', 'sqldb', X(3), Y(1.5)],
      ['rep', 'replica', X(4), Y(1.5)],
    ], ['u>lb', 'lb>app', 'app>cache', 'cache>db', 'app>db', 'db>rep']),
  },
  {
    title: 'Async write pipeline',
    desc: 'API enqueues writes to Kafka, workers drain into the database.',
    graph: G([
      ['u', 'client', X(0), Y(1), { rps: 4000, readRatio: 0.5 }],
      ['lb', 'lb', X(1), Y(1)],
      ['app', 'app', X(2), Y(1), { instances: 10 }],
      ['cache', 'cache', X(3), Y(0)],
      ['q', 'queue', X(3), Y(2)],
      ['wk', 'worker', X(4), Y(2), { instances: 4 }],
      ['db', 'sqldb', X(5), Y(1), { size: 'L' }],
    ], ['u>lb', 'lb>app', 'app>cache', 'cache>db', 'app>q', 'q>wk', 'wk>db']),
  },
  {
    title: 'Media site with CDN',
    desc: 'Static assets from the edge, API through the origin.',
    graph: G([
      ['u', 'client', X(0), Y(1), { rps: 20000, readRatio: 0.98, staticRatio: 0.8, staticKB: 400 }],
      ['cdn', 'cdn', X(1), Y(1)],
      ['blob', 'blob', X(2), Y(0)],
      ['lb', 'lb', X(2), Y(1.6)],
      ['app', 'app', X(3), Y(1.6), { instances: 8 }],
      ['cache', 'cache', X(4), Y(1)],
      ['db', 'sqldb', X(4), Y(2.3)],
    ], ['u>cdn', 'cdn>blob', 'cdn>lb', 'lb>app', 'app>cache', 'cache>db', 'app>db']),
  },
  { title: 'Empty canvas', desc: 'Start from nothing.', graph: { nodes: [], edges: [] } },
];
