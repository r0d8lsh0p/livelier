// Phase 0 exclusivity gate (read side): confirm NONE of the derived proxy npubs
// have any events on major PUBLIC relays. Pulls the author set from the local
// relay, then REQs each public relay for those authors. Expect zero.
//
// Usage: node scripts/check-exclusivity.mjs
import WebSocket from 'ws';

const LOCAL = process.env.LOCAL_RELAY_URL || 'ws://localhost:7449';
const PUBLIC_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];

function collectAuthors(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const authors = new Set();
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(authors);
    }, 8000);
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'a', { kinds: [0, 30311], limit: 5000 }])));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m[0] === 'EVENT') authors.add(m[2].pubkey);
      if (m[0] === 'EOSE') { clearTimeout(timer); try { ws.close(); } catch {} resolve(authors); }
    });
    ws.on('error', reject);
  });
}

function countFor(url, authors) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let found = 0;
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(found); }, 10000);
    ws.on('open', () =>
      ws.send(JSON.stringify(['REQ', 'x', { authors: [...authors], limit: 500 }]))
    );
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m[0] === 'EVENT') found += 1;
      if (m[0] === 'EOSE') { clearTimeout(timer); try { ws.close(); } catch {} resolve(found); }
    });
    ws.on('error', () => { clearTimeout(timer); resolve(found); });
  });
}

const authors = await collectAuthors(LOCAL);
console.log(`Derived proxy authors on local relay: ${authors.size}`);
if (authors.size === 0) {
  console.log('No authors yet — run the poller first.');
  process.exit(0);
}
let leaked = 0;
for (const relay of PUBLIC_RELAYS) {
  const n = await countFor(relay, authors);
  console.log(`${relay}: ${n} events for these authors`);
  leaked += n;
}
console.log(leaked === 0 ? '\nPASS: no bridged events found on public relays.' : `\nFAIL: ${leaked} leaked events!`);
process.exit(leaked === 0 ? 0 : 1);
