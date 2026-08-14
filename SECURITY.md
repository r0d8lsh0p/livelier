# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub's private vulnerability reporting](https://github.com/r0d8lsh0p/livelier/security/advisories/new)
on this repository. Do not open a public issue for anything you believe is
exploitable.

You can expect an acknowledgement within a few days. Please include enough
detail to reproduce (affected component, relay/network posture, steps).

## Scope

Reports we especially want:

- **Write-containment escapes** — any path by which the bridge publishes
  an event to a relay that was not explicitly named (see
  [docs/security.md](docs/security.md); this is the system's central
  invariant).
- **Identity/key issues** — key derivation weaknesses, ways to make the
  bridge sign as an identity it shouldn't, or to impersonate bridged
  chatters.
- **Relay-policy bypasses** — writing to the event relay without the
  whitelisted bridge key, bypassing NIP-42/NIP-70 enforcement on the chat
  relay, or abusing the `/demand` endpoint.
- **Injection via bridged content** — chat messages, Owncast metadata, or
  directory responses that break out of their expected handling.

Out of scope: rate-limiting/availability of third-party public relays,
issues in Owncast itself or in upstream relay software (report those
upstream), and anything requiring a compromised host.

## Deployment notes for operators

- Never run a deployed environment with the default
  `BRIDGE_KEY_SECRET` from the compose file — its keypair is derivable by
  anyone with a copy of this repository. Generate real secrets
  (`openssl rand -hex 32`).
- The architecture-level security model (identity root, relay posture,
  chatter containment) is documented in [docs/security.md](docs/security.md).
