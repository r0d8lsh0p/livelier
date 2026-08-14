# Adding a source network

A new bridged network (PeerTube, Streamplace, …) touches exactly three places
— **never `core/` and never another adapter**:

1. `src/sources/<key>/adapter.ts` — implement `DiscoveryAdapter`, and
   `ChatAdapter` if the network has chat
2. `src/config.ts` — a `<KEY>_*` env block
3. `src/index.ts` — one block in the composition root

`sources/owncast/` is the reference implementation throughout.

## 1. The adapter

### Identity constants

```ts
export class PeertubeAdapter implements DiscoveryAdapter /*, ChatAdapter */ {
  readonly sourceKey = 'peertube';   // DB scoping + key-derivation namespace
  readonly sourceName = 'PeerTube';  // human name, used in profile copy
  readonly dTagPrefix = 'pt';        // 2–3 chars — see length rule below
  readonly proxyProtocol = 'activitypub'; // NIP-48
```

Rules:

- **`sourceKey` is identity-bearing and permanent.** It namespaces every
  derived instance key and scopes every DB row. Changing it later re-keys the
  network's whole fleet and orphans its published events.
- **`dTagPrefix` must keep the full d-tag under 30 characters** (prefix + `-`
  + 16 hex = prefix ≤ 13, but keep it 2–3 chars). Longer coordinates silently
  break `#a` queries on nostrlib-based relays.
- `proxyProtocol` is one of NIP-48's values (`web`, `activitypub`, `atproto`,
  `rss`).

### Discovery half (`DiscoveryAdapter`)

```ts
fetchLive(): Promise<DiscoveryResult>;
checkLiveness(streamUrl: string): Promise<Liveness>;
```

- `fetchLive()` returns the network's current live set, normalized to
  `DiscoveredLive` (canonical URL as the identity key, playable stream URL,
  kind-0 picture, 30311 preview image, `startsAt` unix seconds or null,
  hashtag slugs). Include the raw source objects verbatim in `result.raw` —
  they feed hourly observation snapshots — and a `schemaVersion` fingerprint
  so the engine logs upstream schema drift.
- **Throw on source outage.** The engine keeps last-known state on a throw;
  returning an empty live set instead would start tearing streams down.
- **Push-style sources still implement `fetchLive()`.** A firehose adapter
  (e.g. ATProto Jetstream) consumes its subscription into an in-memory
  live-set and answers instantly. There is deliberately ONE lifecycle engine;
  do not build a second push-shaped one.
- `checkLiveness(streamUrl)` is ground truth, probing the stream itself — the
  live feed is only discovery. Learn from Owncast's probe: after a stream
  ends Owncast keeps serving playlists of offline-slate segments, so the
  generic "playlist exists" heuristic reads ended streams as live. Find your
  network's equivalent lie and handle it.
- Do not filter NSFW; set the flag and the engine labels it (NIP-36).

The engine owns everything else: hash-gated kind-0 publishing, heartbeat
republish, failure-counted teardown, snapshots, DB state. You never publish
events from an adapter.

### Chat half (`ChatAdapter`, optional)

```ts
openListener(instanceUrl, onMessage): Promise<ChatListenerHandle>;
sendMessage(instanceUrl, senderKey, displayName, text): Promise<void>;
closeRoom(instanceUrl): void;
closeAll(): void;
```

- The core speaks **plain text only**. Convert your network's wire format
  (HTML, XMPP stanzas, records) at this boundary, both directions.
- `openListener` must emit only genuine third-party messages: filter out your
  own sender identities (echo) and empty bodies before calling `onMessage`.
- Join honestly: the listener presents the bridge's display name — the join
  IS the disclosure to the source community.
- `sendMessage` keeps one source-side identity per `senderKey` (the Nostr
  pubkey) so messages attribute stably; pace sends if the platform
  flood-protects (Owncast silently drops rapid messages).

The core owns rooms, chatter identities, dedup, demand gating, and all Nostr
I/O. An adapter never talks to a relay.

## 2. The config block

Mirror `OwncastSourceConfig`: `<KEY>_ENABLED` (default true),
`<KEY>_DISCOVERY_ENABLED`, cadence/timeout knobs with the same defaults unless
the network warrants otherwise, and independent chat gates
`<KEY>_CHAT_TO_NOSTR` / `<KEY>_CHAT_FROM_NOSTR` (default false).

## 3. The composition root

Copy the Owncast block in `src/index.ts`: build the adapter, then a
`DiscoveryBridgeService` if discovery is enabled, then a `ChatBridgeService`
if either chat gate is on. Core config (relays, secret, DB, network-relay
posture) is shared; only the source block differs.

## Database

Nothing to do — rows and snapshots are automatically scoped by your
`sourceKey`. If your network genuinely needs new columns, append a migration
in `src/core/migrations.ts` (append-only; never edit a shipped one).

## Testing expectations

- Unit-test the adapter like `sources/owncast/adapter.test.ts`: the
  normalization mapping, liveness classification against captured fixtures,
  and (for chat) echo filtering + format conversion. Mock your network's
  clients; the engine and chat service are already covered against the
  adapter interfaces.
- **No test may touch a real relay or a real third-party instance.** The
  compose stack provides the relays, a scratch `dummy-network-relay`, and the
  pattern of a local test instance (`owncast-test`); flag-on runs point
  `NETWORK_*_RELAYS` at the dummy.
- Extend `scripts/e2e-full-stack.mjs` (or add a sibling) to prove your
  discovery loop and, if applicable, both chat directions end-to-end locally.

## Checklist

- [ ] `sources/<key>/adapter.ts` with identity constants per the rules above
- [ ] Discovery: normalization + ground-truth liveness, outage = throw
- [ ] Chat (if any): plain-text boundary, echo filtering, honest join
- [ ] `<KEY>_*` config block with independent gates, all defaulting safe
- [ ] Composition-root block
- [ ] Adapter unit tests; local e2e green; **zero public-relay contact**
- [ ] `npm test && npx tsc --noEmit` clean
- [ ] Read [architecture.md](architecture.md) invariants — your change breaks none
