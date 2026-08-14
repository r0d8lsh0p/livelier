// Quick relay inspector for the local observation stack.
// Usage: node operations/query-relay.mjs [wsUrl]
import WebSocket from 'ws';

const url = process.argv[2] || 'ws://localhost:7449';
const ws = new WebSocket(url);
const byKind = new Map();
const authors = new Set();
let sample30311 = null;
let sample0 = null;

const subId = 'inspect';
const timer = setTimeout(finish, 8000);

ws.on('open', () => {
  ws.send(JSON.stringify(['REQ', subId, { kinds: [0, 30311], limit: 5000 }]));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg[0] === 'EVENT' && msg[1] === subId) {
    const ev = msg[2];
    byKind.set(ev.kind, (byKind.get(ev.kind) || 0) + 1);
    authors.add(ev.pubkey);
    if (ev.kind === 30311 && !sample30311) sample30311 = ev;
    if (ev.kind === 0 && !sample0) sample0 = ev;
  } else if (msg[0] === 'EOSE' && msg[1] === subId) {
    finish();
  }
});

ws.on('error', (e) => {
  console.error('WS error:', e.message);
  process.exit(1);
});

function finish() {
  clearTimeout(timer);
  console.log('Relay:', url);
  console.log('Counts by kind:', Object.fromEntries(byKind));
  console.log('Unique authors (derived npubs):', authors.size);
  if (sample30311) {
    console.log('\nSample kind-30311 tags:');
    console.log(JSON.stringify(sample30311.tags, null, 2));
  }
  if (sample0) {
    console.log('\nSample kind-0 content:');
    console.log(sample0.content);
  }
  try { ws.close(); } catch {}
  process.exit(0);
}
