#!/usr/bin/env bash
# Deploy Banbo to NEAR testnet and give an agent a restricted key.
# Needs near-cli-rs (https://github.com/near/near-cli-rs) and testnet accounts
# you control. Usage:
#   OWNER=you.testnet VAULT=vault.you.testnet AGENT=agent.you.testnet \
#   VENDOR=vendor.testnet ./scripts/deploy-testnet.sh
# Optional: WITH_USDC=1 also sets up Circle's testnet USDC (registers the vault
# and vendor with the token, adds it to the vault, gives the agent USDC
# limits). USDC_FUND=25 then moves 25 test USDC from OWNER into the vault.
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

if [ "${WITH_USDC:-}" = 1 ]; then
  # Circle's native USDC on NEAR testnet (mainnet:
  # 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1).
  # Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
  USDC="${USDC:-3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af}"
  U() { awk "BEGIN{printf \"%d\", $1*1000000}"; }
  for acct in "$VAULT" "$VENDOR"; do
    near contract call-function as-transaction "$USDC" storage_deposit \
      json-args "{\"account_id\":\"$acct\",\"registration_only\":true}" \
      prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$OWNER" network-config testnet sign-with-keychain send
  done
  near contract call-function as-transaction "$VAULT" add_token \
    json-args "{\"token\":\"$USDC\",\"symbol\":\"USDC\",\"decimals\":6,\"shared_cap\":\"$(U 100)\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config testnet sign-with-keychain send
  near contract call-function as-transaction "$VAULT" set_agent_token_limits \
    json-args "{\"agent\":\"$AGENT\",\"token\":\"$USDC\",\"per_tx_max\":\"$(U 10)\",\"period_limit\":\"$(U 40)\",\"approval_threshold\":\"$(U 10)\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config testnet sign-with-keychain send
  if [ -n "${USDC_FUND:-}" ]; then
    near contract call-function as-transaction "$USDC" ft_transfer_call \
      json-args "{\"receiver_id\":\"$VAULT\",\"amount\":\"$(U "$USDC_FUND")\",\"msg\":\"\"}" \
      prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER" network-config testnet sign-with-keychain send
  fi
fi

echo "Deployed. Inspect: https://testnet.nearblocks.io/address/$VAULT"
