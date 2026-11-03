#!/usr/bin/env bash
# Deploy Banbo to NEAR testnet (or mainnet) and give an agent a restricted key.
# Needs near-cli-rs (https://github.com/near/near-cli-rs) and accounts you
# control; AGENT must already exist. Usage:
#   OWNER=you.testnet VAULT=vault.you.testnet AGENT=agent.you.testnet \
#   VENDOR=vendor.testnet ./scripts/deploy-testnet.sh
# Mainnet (real NEAR): NETWORK=mainnet, with .near accounts. The vault is
# funded with VAULT_NEAR (default 15 on testnet, 9 on mainnet: about 7.7 NEAR
# stays locked for the contract's storage). SHARED_CAP, PER_TX, DAILY and
# APPROVAL set the limits in NEAR (defaults 5 / 0.5 / 3 / 0.4).
# Optional: WITH_USDC=1 also sets up Circle's USDC for the network (registers the vault
# and vendor with the token, adds it to the vault, gives the agent USDC
# limits). USDC_FUND=25 then moves 25 USDC from OWNER into the vault.
set -euo pipefail
: "${OWNER:?}" "${VAULT:?}" "${AGENT:?}" "${VENDOR:?}"
NETWORK="${NETWORK:-testnet}"
case "$NETWORK" in testnet|mainnet) ;; *) echo "NETWORK must be testnet or mainnet" >&2; exit 1;; esac
if [ "$NETWORK" = mainnet ]; then VAULT_NEAR="${VAULT_NEAR:-9}"; else VAULT_NEAR="${VAULT_NEAR:-15}"; fi
WASM="$(dirname "$0")/../contract/res/banbo.wasm"
NEAR() { printf '%s000000000000000000000' "$(awk "BEGIN{printf \"%d\", $1*1000}")"; }

near account create-account fund-myself "$VAULT" "$VAULT_NEAR NEAR" autogenerate-new-keypair --signature-scheme ed25519 \
  save-to-keychain sign-as "$OWNER" network-config "$NETWORK" sign-with-keychain send

near contract deploy "$VAULT" use-file "$WASM" with-init-call new \
  json-args "{\"owner\":\"$OWNER\",\"period_ms\":86400000,\"shared_cap\":\"$(NEAR "${SHARED_CAP:-5}")\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config "$NETWORK" sign-with-keychain send

near contract call-function as-transaction "$VAULT" add_agent \
  json-args "{\"agent\":\"$AGENT\",\"per_tx_max\":\"$(NEAR "${PER_TX:-0.5}")\",\"period_limit\":\"$(NEAR "${DAILY:-3}")\",\"approval_threshold\":\"$(NEAR "${APPROVAL:-0.4}")\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config "$NETWORK" sign-with-keychain send

near contract call-function as-transaction "$VAULT" allow_recipient \
  json-args "{\"recipient\":\"$VENDOR\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config "$NETWORK" sign-with-keychain send

# The agent's runtime key: can only call request_payment on the vault. The
# allowance only pays for gas, charged at each call's full prepaid gas
# (100-150 Tgas, about 0.01-0.015 NEAR at the minimum gas price). The key is
# saved as a file under ~/.near-credentials/<network>/ so the MCP server can use it
# (BANBO_CREDENTIALS_FILE).
near account add-key "$AGENT" grant-function-call-access --allowance '1 NEAR' \
  --contract-account-id "$VAULT" --function-names 'request_payment' \
  autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config "$NETWORK" sign-with-keychain send

if [ "${WITH_USDC:-}" = 1 ]; then
  # Circle's native USDC on NEAR.
  # Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
  if [ "$NETWORK" = mainnet ]; then DEFAULT_USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
  else DEFAULT_USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af; fi
  USDC="${USDC:-$DEFAULT_USDC}"
  U() { awk "BEGIN{printf \"%d\", $1*1000000}"; }
  for acct in "$VAULT" "$VENDOR"; do
    near contract call-function as-transaction "$USDC" storage_deposit \
      json-args "{\"account_id\":\"$acct\",\"registration_only\":true}" \
      prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$OWNER" network-config "$NETWORK" sign-with-keychain send
  done
  near contract call-function as-transaction "$VAULT" add_token \
    json-args "{\"token\":\"$USDC\",\"symbol\":\"USDC\",\"decimals\":6,\"shared_cap\":\"$(U 100)\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config "$NETWORK" sign-with-keychain send
  near contract call-function as-transaction "$VAULT" set_agent_token_limits \
    json-args "{\"agent\":\"$AGENT\",\"token\":\"$USDC\",\"per_tx_max\":\"$(U 10)\",\"period_limit\":\"$(U 40)\",\"approval_threshold\":\"$(U 10)\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config "$NETWORK" sign-with-keychain send
  if [ -n "${USDC_FUND:-}" ]; then
    near contract call-function as-transaction "$USDC" ft_transfer_call \
      json-args "{\"receiver_id\":\"$VAULT\",\"amount\":\"$(U "$USDC_FUND")\",\"msg\":\"\"}" \
      prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER" network-config "$NETWORK" sign-with-keychain send
  fi
fi

if [ "$NETWORK" = mainnet ]; then EXPLORER=https://nearblocks.io; else EXPLORER=https://testnet.nearblocks.io; fi
echo "Deployed. Inspect: $EXPLORER/address/$VAULT"
