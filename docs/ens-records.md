# ENS agent record schema

Each provider agent (`<label>.chirag126.eth`) publishes these ENS text records on its own
PermissionedResolver. The agent discovers providers from them at runtime; nothing about a provider
is hard-coded.

- **Source of truth:** [`packages/ens/src/records.ts`](../packages/ens/src/records.ts)
  (`AGENT_RECORD_SPEC`). The key table below is generated from it, and a test fails if they
  drift.
- **Decision:** D-032.

## Rules

- **Untrusted input.** Anyone can write anything to their own name, so every value is:
  - trimmed and length-capped
  - rejected if it contains control characters
  - validated per key

  Problems are reported by key and code, never echoing the value. A provider with any problem is
  skipped by discovery.

- **Standards.** The seven canonical keys follow the owner's plan (row 11). Where ENSIP-26 (draft,
  "Agent Text Records") applies, its keys are used:
  - `agent-context`: free-form description. It is treated as untrusted text and delimited when
    given to a model.
  - `agent-endpoint[x402]`: a protocol-specific endpoint. ENSIP-26 allows new protocol values.
    It must equal `agent.endpoint`.

  `description` is the standard ENSIP-5 key.

- **Payout keys are admin-only.**
  - `x402.payTo`, `x402.network` and `x402.asset` decide where money goes, so only the
    parent owner writes them.
  - Operators get scoped roles for the other keys (plan row 12, ENS permission enforcement).
  - The spending firewall rejects any x402 quote whose payee, network or asset differs from these
    records.
- **Only `agent.status = active`** agents are purchasable.
- **Endpoints must use https.** `http://localhost` is accepted only with `allowLocalHttp`, in
  local development, and the domain model still refuses it as a deployable provider.
- **Money.** `agent.price` is a canonical positive integer in atomic units of `x402.asset`
  (tinybars for HBAR, `0.0.0`).

## Keys

<!-- generated from AGENT_RECORD_SPEC; do not edit by hand -->

| Key                    | Required | Writer   | Max length | Meaning                                                                           | Example                                                 |
| ---------------------- | -------- | -------- | ---------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `agent.endpoint`       | yes      | operator | 512        | Base URL of the x402-protected data service (https; http only for local dev).     | `https://providers.example.com/v1/kev`                  |
| `agent.capabilities`   | yes      | operator | 512        | Comma-separated capability slugs (lowercase, unique, 1–16).                       | `known-exploited-vulns,cve-lookup`                      |
| `agent.price`          | yes      | operator | 40         | Price per request in atomic units of x402.asset (tinybars for HBAR); integer > 0. | `100000`                                                |
| `x402.payTo`           | yes      | admin    | 32         | Hedera account that must receive payment; quotes paying elsewhere are refused.    | `0.0.11044329`                                          |
| `x402.network`         | yes      | admin    | 32         | CAIP-2 network the payment must settle on.                                        | `hedera:testnet`                                        |
| `x402.asset`           | yes      | admin    | 32         | Settlement asset: 0.0.0 for HBAR, otherwise an HTS token ID.                      | `0.0.0`                                                 |
| `agent.status`         | yes      | operator | 16         | active (purchasable), paused (temporarily not), or retired.                       | `active`                                                |
| `agent-context`        | no       | operator | 4000       | ENSIP-26 agent description. Untrusted: delimited when shown to a model.           | `Serves CISA KEV entries matching a product watchlist.` |
| `agent-endpoint[x402]` | no       | operator | 512        | ENSIP-26 endpoint for the x402 protocol; must equal agent.endpoint if set.        | `https://providers.example.com/v1/kev`                  |
| `description`          | no       | operator | 500        | ENSIP-5 human-facing description.                                                 | `Provider agent "kev" (CISA KEV).`                      |

## Problem codes

| Code               | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `MISSING`          | A required key is unset or blank                                        |
| `TOO_LONG`         | Value exceeds the key's maximum length                                  |
| `CONTROL_CHARS`    | Value contains control characters (tab and newline are allowed)         |
| `INVALID`          | Value fails the key's format (URL, slug list, integer, Hedera ID, enum) |
| `CONFLICT`         | `agent-endpoint[x402]` differs from `agent.endpoint`                    |
| `NETWORK_MISMATCH` | `x402.network` is not the network this agent pays on                    |

## Checking a live name

```cmd
pnpm ens:resolve -- --name kev.chirag126.eth --agent
```
