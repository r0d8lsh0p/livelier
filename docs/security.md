# Security and identity notes

## BRIDGE_KEY_SECRET is the fleet's identity root

Every bridged instance's private key is
`HMAC-SHA256(BRIDGE_KEY_SECRET, "<sourceKey>:" + normalizedUrl)`. The
algorithm is public (this repo); the secret is the entire security boundary,
and it faces a **perfect offline verification oracle**: instance URLs are
public, and every derived *pubkey* is published on the relays. An attacker
can guess a candidate secret, derive keys for known URLs, and check against
published npubs at hardware speed, offline, invisibly.

Consequences:

- **The secret must come from a CSPRNG** — `openssl rand -hex 32` (32 bytes /
  64 hex chars). Never a human-chosen passphrase; a dictionary-guessable
  secret is crackable offline regardless of any rate limiting.
- **Env-only, never committed.** The repo ships no secrets; `.env` is
  gitignored.
- **Compromise = every bridged identity at once.** Whoever holds the secret
  can sign as any bridged instance.
- **Rotation re-keys the entire fleet** — every channel gets a new npub and
  all previously published profiles/events orphan. It is a deliberate,
  breaking operation, not routine hygiene.

`BRIDGE_NSEC` (the operator identity that authors every `30311`) takes
precedence over derivation when set; guard it the same way.

## Relay posture

- **Event relay (SW2)**: write whitelist containing ONLY the bridge identity
  pubkey; empty read whitelist (public reads). The shipped image bakes a
  fail-closed placeholder — a deployment that forgets the whitelist rejects
  all writes rather than accepting everyone's.
- **Chat relay (ephemeral-relay)**: strict kind allowlist, TTL on chat kinds
  (`kind:0` exempt), NIP-70 `-` policy enforced via NIP-42 AUTH, and a
  `/demand` endpoint that should be bearer-token gated (`DEMAND_AUTH_TOKEN`)
  since it exposes subscription metadata.

## Bridged-chatter containment

Source-platform chatters never opted into Nostr. The design limits their
exposure:

- Session-random keys (not derived): a chatter's identity does not persist
  across sessions or link across rooms.
- Their `1311`s carry NIP-70 `-` (relays must not accept them from anyone but
  the author over an authed connection — effectively no rebroadcast) and a
  NIP-40 expiration matching the chat relay's TTL.
- Their `kind:0` is name-only plus an explicit "mirrored by an automated
  bridge" notice. With `NETWORK_PROFILE_PUBLISH_ENABLED` these profiles do
  reach the network profile relays (a deliberate product decision — proxied
  chatters deserve names); NIP-09 deletion remains available if one must be
  retracted.

## Network posture: reads free, writes gated

READS are unconstrained — a REQ has no network footprint, and profile
lookups always use the shared profile stack's full relay coverage.

PUBLISHES are the security boundary:

- `NETWORK_PROFILE_PUBLISH_ENABLED` defaults off: a fresh deployment cannot
  write to the wider network by accident.
- **Only ONE environment may ever hold the publish flag** (prod, at launch).
  Every environment derives different keys for the same channels from its
  own `BRIDGE_KEY_SECRET`; staging + local + prod all publishing would mint
  triplicate bridged identities the network keeps forever. The boot log
  warns loudly whenever the flag is set — check posture after any config
  change.
- Every publish in the codebase names its target relays explicitly; nothing
  may publish to "whatever relays the shared client is connected to"
  (machine-enforced by `client.boundary.test.ts`, load-bearing now that
  reads connect the pool to public relays).
- Test harnesses must point the `NETWORK_*_RELAYS` overrides at local dummy
  relays for WRITE paths, never at public ones.

## What the database holds

No secrets and no message content: instance metadata, derived *public* keys,
liveness state, and raw directory snapshots. Treat it as rebuildable cache;
the relays are the record.
