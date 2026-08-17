# Contributing to Livelier

Livelier discovers self-hosted live streams from public directories (Owncast
directory first) and publishes them to the Nostr network as NIP-53 live events,
with optional two-way live chat. Contributions are welcome — the most valuable
kind is an adapter for a new directory, PeerTube or anything else
(see [docs/adding-a-source.md](docs/adding-a-source.md)).

## Before you touch anything

Read [docs/architecture.md](docs/architecture.md), especially the
**invariants** section. They are load-bearing and test-enforced.

## Development setup

Requirements: Node 24+, Docker.

```bash
npm install
npm test              # unit + behavior tests, no network, no stack needed
npm run typecheck
```

Most work never needs more than that: the test suites fake every boundary
(relays, pool, adapter, storage).

### The full local stack

For integration work and the e2e suite you need the compose stack. The two
relay images build from sibling repos:

```bash
docker build -t sw2:livelier-candidate   <path-to-sw2>
docker build -t ephemeral-relay:main     <path-to-ephemeral-relay>

OWNCAST_CHAT_TO_NOSTR=true OWNCAST_CHAT_FROM_NOSTR=true docker compose up -d
```

The chat gates must be exported at `up` time or the chat bridge silently
never starts.

The e2e exercises a local Owncast instance (`owncast-test` in the compose
stack). It needs a video feed and a seeded instance row:

```bash
# feed (get the stream key from the Owncast admin, default creds admin:abc123)
ffmpeg -re -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine \
  -c:v libx264 -preset veryfast -c:a aac -f flv rtmp://localhost:19350/live/<streamkey>
```

Seed a manual row for `http://owncast-test:8080` in the compose Postgres
(see `packages/bridge/e2e/full-stack.mjs`'s header for the expected identity — the
pubkey/d-tag derive from the default dev secret), wait one poll cycle
(~2 minutes), then:

```bash
npm run e2e           # 18 checks; takes ~20 minutes (retraction phase waits out silence windows)
```

## Before opening a PR

1. `npm test` and `npm run typecheck` pass.
2. Every new or changed export has a test — behavior tests with faked
   boundaries, colocated next to the module.
3. No `console.log`; `console.warn`/`console.error` only for genuine
   runtime conditions.
4. If you touched discovery, chat, publishing, or retraction: run the full
   e2e.
5. Comments state constraints, not history — write what the next reader
   needs, not what changed.

Keep PRs focused. A new source adapter should touch `packages/bridge/src/sources/<key>/`,
`src/config.ts`, and the composition root in `src/index.ts` (both in `packages/bridge`) — never `core/`
or other adapters (that seam is the design; see adding-a-source.md).

## Test writes never touch the real network

Flag-on tests point the `NETWORK_*_RELAYS` override vars at the
`dummy-network-relay` compose service. Never at public relays. Read
[docs/security.md](docs/security.md) for why this is non-negotiable.
