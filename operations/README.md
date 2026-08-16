# Livelier — operations

Operational tools for the Livelier bridge.
The report and relay inspectors are read-only; the instance-flag scripts write
to `bridge_instances` and are dry-run by default, `--confirm` gated;
`retract-instance.mjs` writes to the relays and is `--confirm` gated.

All scripts target the DB in `DATABASE_URL` (default: the local compose stack,
`postgres://bridges:bridges@localhost:5544/bridges`) and print the target host
first — check it before `--confirm`.

## db-status.mjs

Read-only, one page: migrations applied, instance counts by
source/status/flag, snapshot freshness. No mutation path exists in this
script, so it is the right first move against any environment — check the
state here before reaching for a flag lever below.

```bash
node operations/db-status.mjs                       # local compose stack
DATABASE_URL=... node operations/db-status.mjs      # staging / production
```

## Instance flags: set-discovery / set-chat

One row per bridged instance in `bridge_instances`; two symmetric booleans,
one script each:

- `discovery_enabled` — off: the poller stops touching the instance (no
  publishes, no liveness probes; open chat rooms close). Already-published
  events REMAIN on the relays — removing them is a separate manual step
  (`node operations/retract-instance.mjs <url> --confirm`).
- `chat_enabled` — the per-room chat allowlist; reconciled every ~30s, no
  deploy. Inert unless `discovery_enabled` and the direction gates
  (`OWNCAST_CHAT_TO_NOSTR`/`OWNCAST_CHAT_FROM_NOSTR`) are on.

New rows are stamped from posture env vars (`OWNCAST_DEFAULT_DISCOVERY_ENABLED`
default true, `OWNCAST_DEFAULT_CHAT_ENABLED` default false). Existing rows are
never auto-swept to match posture — explicit settings stick. Track who asked
for an opt-out and why in your own ops notes (email/GH), not the DB.

```bash
# A host asks to be removed: both flags off (history stays on the relays;
# add the retract-instance step above only if they want that gone too):
node operations/set-discovery.mjs https://live.example off --confirm
node operations/set-chat.mjs https://live.example off --confirm

# They change their mind (same npub + d-tag come back — identity is derived):
node operations/set-discovery.mjs https://live.example on --confirm

# Staged chat rollout / per-room kill switch:
node operations/set-chat.mjs https://live.example on --confirm
node operations/set-chat.mjs https://live.example off --confirm
```

## republish-profiles.mjs

The fan-out step after `NETWORK_PROFILE_PUBLISH_ENABLED` turns on: kind-0
publishing is hash-gated, so existing rows never reach the network until their
`profile_hash` is cleared. This script clears it in paced batches (default 15
rows per poll cycle) and the bridge — still the only writer — republishes each
profile on its next cycle to the full write set. The pacing keeps the network
relay's first sight of these authors a slow drip, not a burst.

```bash
node operations/republish-profiles.mjs                 # dry-run: batch plan
node operations/republish-profiles.mjs --confirm       # execute, paced
node operations/republish-profiles.mjs <url> --confirm # one instance only
```

## retract-instance.mjs

Manually removes an instance's published events from the relays: a NIP-09
kind-5 deletion for the 30311 (by coordinate, bridge-signed) and a blank
kind-0 replacement (instance-signed). Deliberately not automatic — turning
discovery off only stops the machine; erasing history is a separate operator
decision. Refuses to run while discovery is still on for the instance.

Standalone like the other scripts (pg + nostr-tools + raw websocket). Its key
derivations mirror `packages/shared/src/nostr/bridge-key.ts` and must stay
byte-identical — the full-stack e2e runs this script and asserts the 30311
actually disappears from the relay, which is what pins the two together.

```bash
node operations/retract-instance.mjs <url> --confirm
```

## Relay inspectors: query-relay / check-exclusivity

Dependency-light read-only diagnostics (plain WebSocket, no bridge code):

```bash
node operations/query-relay.mjs [wsUrl]     # kind/author census of a relay (default ws://localhost:7449)
node operations/check-exclusivity.mjs       # prove derived npubs have NO events on public relays
```

## build-snapshot-report.mjs

Renders the hourly `live_snapshots` observation table as a browsable report in
the operations house style: summary cards, stacked hourly histograms (streams
by time-already-streaming, NSFW mix, HLS liveness verification, churn), mean
concurrent count per tag, and a sortable per-instance persistence table.

```bash
node operations/build-snapshot-report.mjs              # build + open in browser
node operations/build-snapshot-report.mjs --no-open    # build only
node operations/build-snapshot-report.mjs --out /tmp/report.html
```

- Default output: `$TMPDIR/livelier/live-snapshots-report.html`, opened
  automatically (pass `--no-open` for headless runs).
- Data source: the `live_snapshots` table written by the poller once an hour —
  raw directory JSON of the presently-live set plus that cycle's HLS liveness
  numbers.
- Connection: defaults to the local docker compose stack
  (`postgres://bridges:bridges@localhost:5544/bridges`); override with
  `DATABASE_URL`.
- The `pg` driver is a repo dependency; `npm install` must have run.

Reading the report:

- The pale band in the age histogram is the always-on tail (24/7 webcams,
  radio loops); the red/amber base is genuinely fresh live sessions.
- NSFW streams are bridged with a NIP-36 content-warning tag, not dropped —
  snapshots taken before that change show `bridged < directory`.
- HLS-verified green tracking the directory count is the signal that the
  directory is a trustworthy liveness source.
