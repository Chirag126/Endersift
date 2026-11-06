# Evidence

Real-network evidence files are written here by the project's scripts, for example:

```
pnpm agent:run -- --save-evidence       # e2e/agent-run-*.json (only when every check passes)
pnpm hcs:check -- --save-evidence       # hcs/
pnpm zg:structured -- --save-evidence   # zg/
pnpm ledger:reconcile -- --save-evidence
```

The files from development (2026-10-25 to 2026-10-29) were removed on 2026-11-06 (D-089): they
are being regenerated against the current deployment. Their transaction IDs remain on the public
networks (HashScan, Sepolia Etherscan) and in the README.

## Rules

- Only **real** artefacts: Hedera transaction IDs, facilitator settle responses, Mirror Node
  lookups, Sepolia transaction hashes, ENS resolution outputs, 0G request IDs and usage.
- Each file records the date (UTC), network and the command that produced it.
- Never include private keys, API keys, RPC URLs with keys, or access codes.
- Mocked output is never placed here.

## Layout

```
docs/evidence/
  hedera/   x402 settlements, Mirror Node confirmations
  ens/      registrations, resolvers, permissions
  zg/       inference request IDs, usage
  hcs/      audit topic messages
  e2e/      full run logs
  identity/ ERC-8004 agent registrations
```
