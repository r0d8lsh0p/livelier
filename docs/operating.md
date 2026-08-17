# Operating the bridge

> **Status: partial — runbooks TODO.** The load-bearing operational facts
> live in [architecture.md](architecture.md) and `.env.example` meanwhile.

## Components to deploy

Worker (this package, `Dockerfile`), SW2 event relay, ephemeral chat relay,
Postgres. Reference deployment: Railway (one service each, volumes on both
relays at `/app/db`); local: `docker-compose.yml`.

## First boot

- Generate `BRIDGE_KEY_SECRET` (`openssl rand -hex 32`) and `BRIDGE_NSEC`;
  put the bridge pubkey in SW2's write whitelist.
- Required env: `LOCAL_RELAY_URL`, `DATABASE_URL`, `BRIDGE_KEY_SECRET`
  (+ `EVENT_RELAY_URL`/`CHAT_RELAY_URL` for two-relay setups). Full reference:
  `.env.example`.
- Schema migrates itself at boot (`schema_migrations`); no migration step.
- Check the boot log: `network relay posture` (must match intent) and
  `discovery bridge starting`.

## Monitoring

- Structured per-cycle metrics log line (`poll cycle complete`): directory
  health, HLS liveness split, publishes, relay write failures.
- Hourly `live_snapshots` rows; rendered by
  `operations/build-snapshot-report.mjs` .
- TODO: alerting thresholds, health endpoint.

## Per-instance flags

Two symmetric booleans per instance row:

- `discovery_enabled = false` — the poller stops touching the instance: no
  publishes, no liveness probes; any open chat room closes. Already-published
  events REMAIN on the relays; removing them is the separate manual script
  below. The row must stay — deleting it would let rediscovery re-publish.
- `chat_enabled` — per-room chat allowlist, reconciled every ~30s without a
  deploy. Requires `discovery_enabled` and the direction gates.

New rows are stamped from `OWNCAST_DEFAULT_DISCOVERY_ENABLED` (default true) /
`OWNCAST_DEFAULT_CHAT_ENABLED` (default false) inside the INSERT; the bridge
never auto-sweeps existing rows to match posture, so explicit settings stick.

Operator scripts live in `operations/` (dry-run default, `--confirm`
gated): `set-discovery.mjs <url> on|off` and `set-chat.mjs <url> on|off`.

Opening chat fleet-wide is therefore two moves, and the env var alone is not
enough: set `OWNCAST_DEFAULT_CHAT_ENABLED=true` (new rows, needs a deploy),
then `set-chat.mjs --all on --confirm` (the rows already there, no deploy).
Do them in that order so rows discovered mid-rollout are not missed by both.
The sweep overwrites per-row chat opt-outs, so re-apply any of those after it.
Undo is symmetric and the DB half takes effect within ~30s.

When a streamer asks to be removed: set both flags off (stops everything
going forward), and — only if they also want existing events gone — run
`node operations/retract-instance.mjs <url> --confirm` (NIP-09 kind-5 for
the 30311, blank kind-0 replacement). Keep who-asked-and-why in your own ops
records. Re-enabling restores the same npub and d-tag — identity is derived,
never random.

## Runbooks (TODO)

- Engaging network relays (the one-switch procedure + posture verification).
- Secret/nsec rotation consequences (see [security.md](security.md) — fleet
  re-key).
