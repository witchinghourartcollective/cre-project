# Confidential Workflows

Chainlink's four Confidential Workflows starter templates (TypeScript), copied from
[smartcontractkit/cre-templates](https://github.com/smartcontractkit/cre-templates/tree/main/starter-templates).
They're here to learn the TEE pattern before we build royalty settlement.

Our org is on the Confidential Workflows private-beta waitlist (requested Oct 5, 2026).
Until it's enabled, everything here runs in the **local simulator only**.

| Folder | What it shows | Tests |
|---|---|---|
| `hello-confidential/` | The basic pattern: fetch a secret inside the enclave, call an API from inside, decide, then cross back to the DON for a signed report | 9 |
| `ai-audit-firewall/` | Fetch contract source, classify risk with an LLM, allow / block / escalate onchain. Ships a Solidity consumer | 14 |
| `automated-liquidation-protection/` | Watch a lending position's health factor and add collateral or repay debt, with private risk thresholds | 5 |
| `automated-portfolio-rebalancing/` | Track allocation drift and rebalance, with private target weights and trade limits | 8 |

## Run the tests (no login needed)

```bash
cd confidential/<template>/<workflow-dir>
bun install
bun test
```

## Simulate (needs `cre login`)

Run every command from the template's **project root** (the folder with `project.yaml`).

### hello-confidential

```bash
cd confidential/hello-confidential
cd my-workflow && bun install && cd ..
cp .env.example .env          # SECRET_API_TOKEN can stay a dummy; it calls postman-echo.com
cre workflow simulate my-workflow --target staging-settings --non-interactive --trigger-index 0
```

### The other three

Each one ships a local mock API on port 8787, so start it in a second terminal first.
Only one mock server can run at a time.

```bash
cd confidential/automated-liquidation-protection     # or ai-audit-firewall / automated-portfolio-rebalancing
cp .env.example .env                                 # mock values only
cd automated-liquidation-protection-ts && bun install

# terminal 2
bun run mock:server

# terminal 1, back in the project root
cd ..
cre workflow simulate ./automated-liquidation-protection-ts --target staging-settings --non-interactive --trigger-index 0
```

The upstream READMEs say `cre workflow simulate ./automated-liquidation-protection`. The workflow
folder is actually named `...-ts`, so use the commands above.

## What the enclave hides and what it doesn't

- **Hidden from node operators:** secrets (API keys and private thresholds), HTTP request and response
  bodies made from inside the enclave, and intermediate values.
- **Not hidden:** the workflow code itself, triggers, onchain reads and writes, logs, and anything passed
  out through `usingTheDons()`.
- The beta runs on AWS Nitro in `us-west-2` only, and workflows currently share an enclave.

## Next: royalty settlement

The closest starting point is `hello-confidential`. Its pattern maps directly onto royalty settlement:
secret, fetch inside the enclave, decide, cross back.
1. Replace the API call with distributor statement fetches, keeping the API keys in `secrets.yaml`.
2. Replace `scoreResponse` with the split calculation (per-track splits held as secrets).
3. Cross back with only the payout totals or a hash of the settlement batch.
4. Write the report to a consumer contract on Base, following the same `ReceiverTemplate` pattern as coin-breaker.
