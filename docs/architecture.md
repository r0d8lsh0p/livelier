# Livelier bridge — architecture and invariants

Livelier bridges external live-streaming networks into Nostr: each live stream
on a bridged network becomes a NIP-53 live event (`kind:30311`) discoverable in
Shosho, Zap.Stream, Amethyst, Primal, and any other NIP-53 client, with
optional two-way live chat (`kind:1311`) between the source platform and Nostr.

Owncast is the first bridged network. The package is built as a multi-source
adapter architecture so further networks (PeerTube, Streamplace, …) are added
as adapters, not forks — see [adding-a-source.md](adding-a-source.md).

## Topology

One worker process plus two relays and a Postgres:

| Component | Role | Posture |
|---|---|---|
| **Bridge worker** (this package) | Discovery engines + chat services, one pair per enabled source | Stateless apart from Postgres |
| **Event relay** (SW2) | Durable discovery events: every `30311`, plus the operator-curated bridge `kind:0` | Write whitelist = the bridge identity pubkey ONLY; reads open to everyone |
| **Chat relay** (ephemeral-relay) | Chat-session events: bridged `1311`s, instance host `kind:0`s + NIP-65 relay lists, chatter identities | Strict kind allowlist, ~3 h TTL (`kind:0` exempt), NIP-40/70 enforced, NIP-42 AUTH for protected events, `GET /demand` |
| **Postgres** | Instance state, hourly observation snapshots | A working cache — **the relay is the durable record**; the DB can be rebuilt from a few poll cycles |

Clients discover streams by reading `30311`s from the event relay; the event's
NIP-53 `relays` hint points them at the chat relay for the room.

## Event model (discovery)

- **Author = the bridge identity** (NIP-53 provider pattern, as zap.stream
  does). The instance's own derived key is the `p` host tag; its `kind:0`
  presents the channel.
- **`d` tag**: `<prefix>-<16 hex of sha256(normalized url)>` (e.g. `oc-…`),
  unique per instance because a single author would otherwise collide
  coordinates. Kept **under 30 characters** — see invariant 4.
- **`proxy` tag** (NIP-48) attributes the source instance; protocol per
  adapter (`web` for Owncast).
- **`relays` hint carries the chat relay ONLY** — see invariant 2.
- **NSFW is carried, not filtered**: the source's self-declared flag becomes a
  NIP-36 `content-warning` tag.
- **Lifecycle**: publish on first sight and on any status change; heartbeat
  republish every 15 min while live; after 3 consecutive liveness failures a
  terminal `status:ended` event publishes. Source liveness probes (e.g. the
  slate-aware Owncast HLS check) are ground truth; the source's own live feed
  is only discovery. `starts` is preserved across republishes and reset only
  on an ended→live transition.

## Chat model

- Rooms are the per-instance allowlist: rows with `chat_enabled` AND
  `status = 'live'`, scoped to the adapter's source.
- **Source → Nostr**: the adapter joins the source chat under the bridge's
  honest display name (the join IS the disclosure). Each source-side chatter
  gets an ephemeral random keypair for the session; their messages publish as
  `1311`s carrying NIP-70 `-` and a NIP-40 expiration matching the chat
  relay's TTL — bridged chatters never opted into Nostr, so their mirrored
  messages must not outlive it. Protected events are published via one-shot
  NIP-42 connections authed as the event's author.
- **Nostr → source**: `1311`s tagged with a room's `#a` are delivered into the
  source chat under the Nostr user's display name via per-sender source
  connections.
- **Presence (source → Nostr)**: a source join announcement bridges
  faithfully as NIP-53 room presence (`kind:10312`, empty content, `a` tag
  with relay hint + `root`) under the chatter's session key — one 10312 per
  join the source announces, nothing invented, nothing suppressed beyond our
  own echo (the listener's registration and sender-pool identities). Carries
  NIP-70 `-` and the same NIP-40 expiration as bridged `1311`s: join lines
  and messages share one lifetime.
- **3-layer dedup** prevents echo loops: L1 our own `client` tag, L2 the set
  of pubkeys we created, L3 a (name, content) fingerprint per room.
- **Demand gating** (Owncast → Nostr only): with a `/demand` endpoint
  configured, the source-side listener opens only once a Nostr viewer
  subscription names the room's `#a`; established listeners are never torn
  down on a demand dip. Nostr → source delivery needs no listener and is not
  demand-gated.
- **Reads**: a deliberately unscoped `kind:1311` firehose on our chat relay
  (see invariant 9), plus — when network relays are enabled — a wide
  chat-kind firehose on the network read set, so a correctly `#a`-tagged
  event published to public relays by a viewer who never touched our chat
  relay still bridges. All room routing is internal, off each event's `a` tag.

## Identity

Everything derives from one secret (see [security.md](security.md)):

- Instance keys: `HMAC-SHA256(BRIDGE_KEY_SECRET, "<sourceKey>:" + normalizedUrl)`
  — deterministic, so the same channel is the same npub across restarts and
  rebuilds; namespaced per source so two networks can never collide.
- The bridge operator identity comes from `BRIDGE_NSEC` when set, else is
  derived from the same secret under a namespace no URL can occupy.
- Chatter keys are the exception: random per session, by design.

## Network relays: reads are free, writes are gated

The governing asymmetry: a READ against a public relay has no network
footprint; a PUBLISH is permanent, attributable fan-out. So:

- **Profile reads have no flag.** Inbound chatter names resolve through the
  shared profile stack (coordinator: batching, in-flight dedup, retry
  ledger) across its full relay coverage, always — with the bridge's own
  chat relay as a parallel fallback for identities that only exist there.
- **`NETWORK_PROFILE_PUBLISH_ENABLED`** (default off) is the write gate: on,
  all bridge-published `kind:0`s (instances, operator, chatters + their
  `10002`s) also publish to the profile-write set (purplepag.es). Every
  environment derives DIFFERENT keys for the same channels, so **only one
  environment — prod, at launch — may ever hold this flag**; a second
  publisher mints duplicate identities the network keeps forever. The boot
  log warns loudly when it is set.
- **`NETWORK_CHAT_READ_ENABLED`** (default off) activates the network chat
  firehose (above). Technically just reads — it exists as a product-rollout
  gate, because it changes what lands in source-platform chats.

The relay sets are curated in `packages/bridge/src/core/relays.ts` — changing WHICH relays is
a reviewed code change. The `NETWORK_*_RELAYS` env vars exist only so test
harnesses substitute local dummy relays for WRITE paths. The boot log prints
the effective posture.

## Data

Postgres schema is managed by versioned boot-time migrations
(`packages/bridge/src/core/migrations.ts`): ordered embedded steps, tracked in
`schema_migrations`, serialized by an advisory lock. Operators never run a
migration command. The `bridge_instances` table is keyed by URL and scoped by
`source` (network key) with `origin` provenance (`discovered`/`manual`);
`live_snapshots` holds hourly raw observations for reporting.

## Invariants — do not break these

Changes that violate any of these have caused (or would cause) real breakage.

1. **Every publish names its relays explicitly.** There is no default-relay
   fallback anywhere; an unset relay URL is a boot error, never a silent
   fallback to the public network.
2. **The `30311` `relays` hint lists the chat relay ONLY.** Clients treat the
   hint as "where the 1311 room lives" for both reading and writing —
   zap.stream uses just the FIRST URL — and the event relay's write whitelist
   would reject their chat.
3. **Bridged `1311`s never leave the chat relay.** NIP-70 `-` plus NIP-40
   expiration; they are not published to network relays even when the network
   flag is on.
4. **d-tags stay under 30 characters.** Relays on nostrlib's LMDB backend
   truncate the d-tag portion of their `#a` index at 30 bytes and then
   silently match nothing — which kills client chat lookups.
5. **Test WRITES never touch public relays.** Flag-on testing uses the
   `dummy-network-relay` compose service via the `NETWORK_*_RELAYS` overrides.
   (Reads are harmless and unconstrained — keep them local in automated tests
   for determinism, not dogma.)
6. **Publishing to the network is gated; reading never is.**
   `NETWORK_PROFILE_PUBLISH_ENABLED` defaults off and only ONE environment
   may ever hold it (different envs derive different keys for the same
   channels — a second publisher mints permanent duplicates). Every publish
   in the codebase names its target relays explicitly; no publish may fall
   back to the shared client's connected pool (enforced by
   `client.boundary.test.ts`).
7. **Migrations are append-only.** Never edit or reorder a shipped migration;
   installations in the wild have recorded it as applied.
8. **`sourceKey` and `BRIDGE_KEY_SECRET` are identity-bearing.** Changing
   either re-keys a fleet and orphans its published history.
9. **The bridge's own subscriptions on the chat relay carry no `#a`.** The
   relay's `/demand` endpoint counts `#a`-scoped subscriptions as viewer
   demand; a scoped bridge reader would hold source chat connections open
   forever.
10. **NSFW is never filtered**, only labeled (NIP-36).
11. **The discovery flag stops the machine — nothing more.**
    `discovery_enabled=false` stops publishes AND liveness probes, but
    already-published events stay on the relays: removing them is a separate
    manual operator action (`operations/retract-instance.mjs`), never an engine
    behavior — "stop bridging forward, keep the history" must stay possible.
    The row must never be deleted — rediscovery would mint the instance as
    new and re-publish it. Posture env vars stamp NEW rows only, inside the
    INSERT; nothing ever sweeps existing rows to match config, so explicit
    per-row settings (opt-outs, test enables) always stick.
