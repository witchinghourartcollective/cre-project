#!/usr/bin/env bash
# Deploys CoinCircuitBreaker to BASE MAINNET. Run this yourself; it sends one real transaction
# (~2.0M gas, about $0.03 at 0.006 gwei on 2026-10-02).
#
# The deploying wallet becomes the owner: the only address that can unpause a coin. Use a
# wallet you control (e.g. MetaMask), not the flywheel trading wallet.
# Default: forge prompts for the private key with hidden input (never touches disk or history).
# With a Ledger: SIGNER=ledger ./deploy-breaker.sh  (unlock it and open the Ethereum app first).
set -euo pipefail
cd "$(dirname "$0")"

RPC="${BASE_RPC_URL:-https://base.drpc.org}"
# Chainlink production KeystoneForwarder on Base. Verified 2026-10-02 against `cre workflow
# supported-chains`, docs.chain.link forwarder directory, and deployed code on Base.
FORWARDER=0xF8344CFd5c43616a4366C34E3EEE75af79a74482

[ "$(cast chain-id --rpc-url "$RPC")" = "8453" ] || { echo "RPC is not Base mainnet"; exit 1; }
[ "$(cast code "$FORWARDER" --rpc-url "$RPC" | wc -c)" -gt 10 ] || { echo "forwarder has no code"; exit 1; }
forge build >/dev/null

echo "Deploying CoinCircuitBreaker(forwarder=$FORWARDER) to Base mainnet."
read -r -p "Type DEPLOY to continue: " ok
[ "$ok" = "DEPLOY" ] || { echo "aborted"; exit 1; }

case "${SIGNER:-key}" in
  ledger) SIGN=(--ledger) ;;
  key) SIGN=(--interactive) ;;
  *) echo "SIGNER must be key or ledger"; exit 1 ;;
esac

forge create src/CoinCircuitBreaker.sol:CoinCircuitBreaker \
  --rpc-url "$RPC" "${SIGN[@]}" --broadcast \
  --constructor-args "$FORWARDER"

cat <<'EOF'

Next:
  1. Put the "Deployed to:" address in coin-breaker/coin-breaker/config.staging.json and
     config.production.json as "breakerAddress".
  2. After CRE deploy access + `cre account link-key`, restrict the receiver to your
     workflow so nobody else's CRE workflow can pause your coins (owner-only call):
       cast send <breaker> 'setExpectedAuthor(address)' <your linked workflow owner address> \
         --rpc-url https://base.drpc.org --interactive
  3. Set CIRCUIT_BREAKER_ADDRESS=<breaker> on the flywheel deployment (whm-infra).
EOF
