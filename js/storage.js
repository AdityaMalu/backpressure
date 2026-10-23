// Local persistence (progress, designs) and shareable links.
// Every access is wrapped: storage can be unavailable (private mode, blocked).

const KEY = 'backpressure.v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* ignore */ }
}

export const store = {
  data: load(),
  get(k, d) { return this.data[k] ?? d; },
  set(k, v) { this.data[k] = v; save(this.data); },
  completed() { return this.get('completed', {}); },
  markComplete(id, info) { const c = this.completed(); c[id] = { at: Date.now(), ...info }; this.set('completed', c); },
  design(id) { return this.get('designs', {})[id]; },
  saveDesign(id, graph) { const d = this.get('designs', {}); d[id] = graph; this.set('designs', d); },
  clearDesign(id) { const d = this.get('designs', {}); delete d[id]; this.set('designs', d); },
};

// Share links: the design is deflated + base64url'd into the URL hash.
async function deflate(str) {
  if (typeof CompressionStream === 'undefined') return 'r' + b64(new TextEncoder().encode(str));
  const cs = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(cs).arrayBuffer());
  return 'z' + b64(buf);
}
async function inflate(s) {
  const kind = s[0];
  const bytes = unb64(s.slice(1));
  if (kind === 'r') return new TextDecoder().decode(bytes);
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(ds).text();
}
function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export async function encodeDesign(obj) { return deflate(JSON.stringify(obj)); }
export async function decodeDesign(s) { return JSON.parse(await inflate(s)); }
