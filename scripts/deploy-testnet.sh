#!/usr/bin/env bash
# Deploy Banbo to NEAR testnet and give an agent a restricted key.
# Needs near-cli-rs (https://github.com/near/near-cli-rs) and testnet accounts
# you control. Usage:
#   OWNER=you.testnet VAULT=vault.you.testnet AGENT=agent.you.testnet \
#   VENDOR=vendor.testnet ./scripts/deploy-testnet.sh
set -euo pipefail
: "${OWNER:?}" "${VAULT:?}" "${AGENT:?}" "${VENDOR:?}"
WASM="$(dirname "$0")/../contract/res/banbo.wasm"
NEAR() { printf '%s000000000000000000000' "$(awk "BEGIN{printf \"%d\", $1*1000}")"; }

near account create-account fund-myself "$VAULT" '12 NEAR' autogenerate-new-keypair \
  save-to-keychain sign-as "$OWNER" network-config testnet sign-with-keychain send

near contract deploy "$VAULT" use-file "$WASM" with-init-call new \
  json-args "{\"owner\":\"$OWNER\",\"period_ms\":86400000,\"shared_cap\":\"$(NEAR 5)\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

near contract call-function as-transaction "$VAULT" add_agent \
  json-args "{\"agent\":\"$AGENT\",\"per_tx_max\":\"$(NEAR 0.5)\",\"period_limit\":\"$(NEAR 3)\",\"approval_threshold\":\"$(NEAR 0.4)\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config testnet sign-with-keychain send

near contract call-function as-transaction "$VAULT" allow_recipient \
  json-args "{\"recipient\":\"$VENDOR\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config testnet sign-with-keychain send

# The agent's runtime key: can only call request_payment on the vault.
near account add-key "$AGENT" grant-function-call-access --allowance '0.25 NEAR' \
  --contract-account-id "$VAULT" --function-names 'request_payment' \
  autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send

echo "Deployed. Inspect: https://testnet.nearblocks.io/address/$VAULT"
