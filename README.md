<div align="center">

<img src="packages/site/brand/assets/Logotext.png" alt="Livelier.live" width="380">

**For *livelier* live streams.**

A free, open-source community project that helps self-hosted live streamers
get found the moment they go live.

[![CI](https://github.com/r0d8lsh0p/livelier/actions/workflows/ci.yml/badge.svg)](https://github.com/r0d8lsh0p/livelier/actions/workflows/ci.yml)
[![Website](https://img.shields.io/badge/livelier.live-visit-FF006E)](https://livelier.live)
[![License: MIT](https://img.shields.io/badge/license-MIT-FFBE0B)](LICENSE)
[![Nostr NIP-53](https://img.shields.io/badge/Nostr-NIP--53-8338EC)](https://github.com/nostr-protocol/nips/blob/master/53.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3A86FF)](packages/bridge/tsconfig.json)

</div>

---

Livelier bridges self-hosted live streams onto [Nostr](https://nostr.com) as
NIP-53 live events, with two-way live chat. Discovery happens on the network;
viewing happens on the streamer's own server. Nothing is re-hosted, nothing is
uploaded.

Owncast is the first bridged network. The architecture is multi-source, so
further networks are adapters, not forks.

## What the bridge actually does

1. **Watches public directories** of self-hosted streams (today: the
   [Owncast directory](https://owncast.directory)) for instances that are live.
2. **Verifies liveness itself** by fetching the instance's HLS playlist — the
   directory is discovery, not ground truth.
3. **Publishes one NIP-53 `kind:30311` live event per live channel** to its own
   discovery relay, carrying the stream's title, artwork, and a player URL
   pointing back at the streamer's own server. A NIP-48 `proxy` tag names the
   source; a NIP-36 `content-warning` tag is added when the instance
   self-declares as adult. Content is never filtered, only labelled.
4. **Bridges `kind:1311` chat in both directions** between the source chat room
   and Nostr. The source-side connection opens only once a network viewer
   subscribes to the room, so an instance with no Nostr audience is not
   connected to.

Any client that speaks NIP-53 can then surface the stream — Zap.Stream, Shosho,
Primal, Amethyst, Nostrudel, and anything else that subscribes to the bridge
relays.

## The two relays

Each relay has one job and a narrow policy, and each declares its behaviour in
its own NIP-11 document — read those rather than trusting this file:

| Relay | Role | Policy | Software |
|---|---|---|---|
| `wss://livestream.livelier.live` | discovery | Holds every `kind:30311`. Write-whitelisted to the bridge key alone; reads open to everyone. | [sw2](https://github.com/bitvora/sw2) |
| `wss://livechat.livelier.live` | chat | `kind:1311` messages and the `kind:0` profiles of bridged channels and chatters. Strict kind allowlist, NIP-42 auth for writers, NIP-70 protection on bridged messages, scheduled hard deletion after a short TTL. | [ephemeral-relay](https://github.com/r0d8lsh0p/ephemeral-relay) |

```bash
curl -H 'Accept: application/nostr+json' https://livechat.livelier.live
```

## The promises

Every commitment [livelier.live](https://livelier.live) makes to streamers is
enforced in this code, by mechanism rather than policy:

- **Content passes through unchanged.** Nothing is edited, filtered, or gated.
- **Overhead is very light.** One playlist check a minute; a chat connection
  opens only while someone is watching.
- **Bridged chat does not persist.** Chat lives on one dedicated relay, is
  marked do-not-share (NIP-70), and is hard-deleted on a timer.
- **The bridge has its own identity.** It joins chats under its own name and
  forces no brand on the streamer or their viewers.
- **Bridged accounts are marked as mirrors.** Everything published is labelled
  as a bridge and links back to the streamer's server as the source.

## The relay invariant

Every publish path writes **exclusively** to the configured event/chat relay pair:
`publisher` methods always pass their target relay explicitly to
`clientService.publishEvent`, and a publish that names no relays **throws** —
there is no default-relay fallback anywhere, by mechanism rather than policy.

## Layout (multi-source adapter architecture)

Source-agnostic machinery lives in `core/`; each bridged network is an adapter
under `sources/` implementing the `DiscoveryAdapter` and (optionally)
`ChatAdapter` seams. Adding a network touches `sources/<key>/`, `config.ts`,
and the composition root in `index.ts` — never `core/` or other adapters.

```
packages/
  bridge/                        @livelier/bridge — the bridge worker
    src/
      index.ts                   composition root: one block per enabled source
      config.ts                  env → { core, owncast } (global + per-source blocks)
      core/
        identity.ts              bridge signer, per-instance signer, d-tag, profile hash
        instance-store.ts        Postgres state, source-scoped (bridge_instances)
        migrations.ts            versioned schema migrations, applied at boot
        metrics.ts               per-cycle observation counters
        types.ts                 InstanceRow
        discovery/
          types.ts               DiscoveryAdapter, DiscoveredLive, Liveness
          discovery-bridge.service.ts  lifecycle engine: poll → liveness → publish → reconcile
        chat/
          types.ts               ChatAdapter, SourceChatMessage
          chat-bridge.service.ts rooms, chatter identities, 3-layer dedup, demand gating
          fingerprint.ts
        nostr/
          live-event.publisher.ts  kind-0 + kind-30311 via shared clientService
          nostr-gateway.ts       the chat service's one seam to the relay
          authed-publish.ts      one-shot NIP-42 publish (NIP-70 policy)
          demand.client.ts       GET /demand reader
      sources/
        owncast/
          adapter.ts             OwncastAdapter: DiscoveryAdapter + ChatAdapter
          discovery/             directory client, slate-aware HLS probe, feed types
          chat/                  WS listener, paced sender pool, HTML↔text
    e2e/
      full-stack.mjs             full-stack E2E against the compose stack
  shared/                        forked Nostr client stack (client.service, signers, tags)
  site/                          livelier.live — the public front page (Vite, static)
operations/                      operator tools: instance flags, retraction, relay
                                 inspectors, snapshot report (see operations/README.md)
docker/                          relay configs for the local compose stack
```

## Identity model

- **30311 author = the bridge identity** ("Livelier", [livelier.live](https://livelier.live)) — NIP-53
  provider pattern, like zap.stream. Key comes from `BRIDGE_NSEC` in `.env`
  (gitignored); falls back to a key derived from `BRIDGE_KEY_SECRET` if unset.
- **`p` host tag = the instance's derived key**, whose kind-0 presents the channel.
- **`client` tag = the bridge name** on every event (`clientService.setClientName`).
- **`d` tag is unique per instance** (`<prefix>-<hash16>`, e.g. `oc-…` for Owncast; kept
  under 30 chars for nostrlib `#a`-index compatibility) — required because a single author
  means the coordinate `30311:<bridge>:<d>` would otherwise collide.

Each channel's identity is derived from its URL, so the same channel is always
the same npub. The derivation needs a secret held only by the bridge operator;
the public half is published and readable by anyone.

## Database migrations

The bridge owns its own Postgres and migrates it automatically at boot: ordered,
versioned steps embedded in `core/migrations.ts`, tracked in `schema_migrations`,
serialized across concurrent boots by a Postgres advisory lock. Operators never
run a migration command — `docker compose up` (or a Railway deploy) applies
whatever is pending. To change the schema, append a new `{ version, name, sql }`
entry; never edit or reorder a shipped migration.

The forked `packages/shared/src/` tree provides the Nostr client stack:
`buildLiveEventTags` (NIP-53 + NIP-48 tags), `DerivedKeySigner`,
`deriveInstancePrivKey` (HMAC per-instance keys), and the profile
read stack (coordinator, caches).

## Run (local observation stack)

From the repo root:

```bash
docker compose up -d      # relay + db + poller
docker compose logs -f poller
node operations/query-relay.mjs ws://localhost:7449
node operations/check-exclusivity.mjs
docker compose down       # stop (add -v to wipe data)
```

Config via env (see `.env.example`). Required: `LOCAL_RELAY_URL`, `DATABASE_URL`, `BRIDGE_KEY_SECRET`.

## Network relays: reads free, writes gated

Profile READS have no flag — inbound chatter names always resolve through
the shared profile stack's full network coverage (reads have no footprint).
Two independent gates, both default **off**:

- `NETWORK_PROFILE_PUBLISH_ENABLED` — the WRITE gate: kind-0s (instance
  hosts, bridge identity, bridged chatters) also publish to
  `NETWORK_PROFILE_WRITE_RELAYS` (purplepag.es). **Only one environment may
  ever hold this flag** — each environment derives different keys for the
  same channels, so a second publisher mints permanent duplicate identities.
  The boot log warns loudly when set.
- `NETWORK_CHAT_READ_ENABLED` — a wide chat-kind firehose on
  `NETWORK_CHAT_READ_RELAYS` catches correctly `#a`-tagged events that never
  reached our chat relay, routing them internally. A product-rollout gate.

The sets are curated in `packages/bridge/src/core/relays.ts` — changing WHICH relays is a
reviewed code change, not an env edit. The `NETWORK_*_RELAYS` env vars exist
only so test harnesses can substitute local dummy relays
(`dummy-network-relay` in the compose stack); never set them in a real
deployment. The boot log prints the effective posture.

## The website

[livelier.live](https://livelier.live) lives in [`packages/site/`](packages/site/) —
a static Vite build that reads live data (stream count, chat count, relay
policies) from the bridge relays in the visitor's browser, so every claim on
the page is verified client-side. It shares the repo's `packages/shared/`
Nostr client through one seam file, `packages/site/src/seam/shared.ts`.

```bash
cd packages/site
npm ci
npm run dev         # local dev server
npm run build       # static build in packages/site/dist/
```

The relay URLs default to production and can be overridden per deploy with
`VITE_EVENT_RELAY` and `VITE_CHAT_RELAY`. Brand assets and the
[brand guide](packages/site/brand/Livelier-brand-guide.md) live in
`packages/site/brand/`.

There is also a machine-readable summary of the whole project at
[`packages/site/public/llms.txt`](packages/site/public/llms.txt), served at
`livelier.live/llms.txt`.

## Test / typecheck

```bash
npm test && npm run typecheck            # bridge + shared (from the repo root)
cd packages/site && npm run typecheck    # website
```

## Docs

- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, test contract, PR expectations
- [docs/architecture.md](docs/architecture.md) — topology, event/chat model, and the **invariants** (read before changing anything)
- [docs/adding-a-source.md](docs/adding-a-source.md) — how to contribute a new bridged network
- [docs/security.md](docs/security.md) — identity root, relay posture, chatter containment
- [docs/operating.md](docs/operating.md) — operator guide (partial — runbooks TODO)
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities

## Opt-out

An instance appears on the bridge because it is listed in a public directory.
Any streamer can [open an issue](https://github.com/r0d8lsh0p/livelier/issues/new)
naming their server to be removed from the bridge — no live events, no chat,
no liveness probing. Retracting already-published events is a further explicit
step; ask and it will be done.

## License

[MIT](LICENSE)
