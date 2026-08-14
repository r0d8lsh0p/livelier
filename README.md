# Livelier

Livelier bridges external live-streaming networks into Nostr: live streams
become NIP-53 live events (kind-30311) discoverable across Shosho, Zap.Stream,
Amethyst, and Primal, with optional two-way live chat (kind-1311) between the
source platform and Nostr. Owncast is the first bridged network; the package
is a multi-source adapter architecture, so further networks are adapters, not
forks.

## Docs

- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, test contract, PR expectations
- [docs/architecture.md](docs/architecture.md) — topology, event/chat model, and the **invariants** (read before changing anything)
- [docs/adding-a-source.md](docs/adding-a-source.md) — how to contribute a new bridged network
- [docs/security.md](docs/security.md) — identity root, relay posture, chatter containment
- [docs/operating.md](docs/operating.md) — operator guide (partial — runbooks TODO)

Livelier began life inside the Shosho monorepo and was extracted as a
standalone project in August 2026.

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
src/
  index.ts                       composition root: one block per enabled source
  config.ts                      env → { core, owncast } (global + per-source blocks)
  core/
    identity.ts                  bridge signer, per-instance signer, d-tag, profile hash
    instance-store.ts            Postgres state, source-scoped (bridge_instances)
    migrations.ts                versioned schema migrations, applied at boot
    metrics.ts                   per-cycle observation counters
    types.ts                     InstanceRow
    discovery/
      types.ts                   DiscoveryAdapter, DiscoveredLive, Liveness
      discovery-bridge.service.ts  lifecycle engine: poll → liveness → publish → reconcile
    chat/
      types.ts                   ChatAdapter, SourceChatMessage
      chat-bridge.service.ts     rooms, chatter identities, 3-layer dedup, demand gating
      fingerprint.ts
    nostr/
      live-event.publisher.ts    kind-0 + kind-30311 via shared clientService
      nostr-gateway.ts           the chat service's one seam to the relay
      authed-publish.ts          one-shot NIP-42 publish (NIP-70 policy)
      demand.client.ts           GET /demand reader
  sources/
    owncast/
      adapter.ts                 OwncastAdapter: DiscoveryAdapter + ChatAdapter
      discovery/                 directory client, slate-aware HLS probe, feed types
      chat/                      WS listener, paced sender pool, HTML↔text
scripts/
  query-relay.mjs          inspect events stored on the local relay
  check-exclusivity.mjs    prove derived npubs have no events on public relays
```

## Database migrations

The bridge owns its own Postgres and migrates it automatically at boot: ordered,
versioned steps embedded in `core/migrations.ts`, tracked in `schema_migrations`,
serialized across concurrent boots by a Postgres advisory lock. Operators never
run a migration command — `docker compose up` (or a Railway deploy) applies
whatever is pending. To change the schema, append a new `{ version, name, sql }`
entry; never edit or reorder a shipped migration.

The vendored `shared/src/` tree provides the Nostr client stack:
`buildLiveEventTags` (NIP-53 + NIP-48 tags), `DerivedKeySigner`,
`deriveInstancePrivKey` (HMAC per-instance keys), and the profile
read stack (coordinator, caches).

## Identity model

- **30311 author = the bridge identity** ("Livelier", [livelier.live](https://livelier.live) — bridging chats for livelier lives) — NIP-53
  provider pattern, like zap.stream. Key comes from `BRIDGE_NSEC` in `.env`
  (gitignored); falls back to a key derived from `BRIDGE_KEY_SECRET` if unset.
- **`p` host tag = the instance's derived key**, whose kind-0 presents the channel.
- **`client` tag = the bridge name** on every event (`clientService.setClientName`).
- **`d` tag is unique per instance** (`<prefix>-<hash16>`, e.g. `oc-…` for Owncast; kept
  under 30 chars for nostrlib `#a`-index compatibility) — required because a single author
  means the coordinate `30311:<bridge>:<d>` would otherwise collide.

## Run (local observation stack)

From the repo root:

```bash
docker compose up -d      # relay + db + poller
docker compose logs -f poller
node scripts/query-relay.mjs ws://localhost:7449
node scripts/check-exclusivity.mjs
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

The sets are curated in `src/core/relays.ts` — changing WHICH relays is a
reviewed code change, not an env edit. The `NETWORK_*_RELAYS` env vars exist
only so test harnesses can substitute local dummy relays
(`dummy-network-relay` in the compose stack); never set them in a real
deployment. The boot log prints the effective posture.

## Test / typecheck

```bash
npm test && npx tsc --noEmit
```
