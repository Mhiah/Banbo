#!/usr/bin/env bash
# Deploy the Banbo factory to NEAR testnet and publish the vault code once, so
# anyone can create a vault from the dashboard with one wallet transaction.
# Needs near-cli-rs and an owner account in your keychain. Usage:
#   OWNER=you.testnet FACTORY=banbo-vaults.testnet ./scripts/deploy-factory-testnet.sh
#
# Publishing global code burns 10x the normal storage cost: about 77 NEAR for
# banbo.wasm. The faucet gives 10 test NEAR per new account, so this creates
# FUNDERS (default 8) throwaway faucet accounts and deletes each one into the
# factory, which moves its whole balance there.
set -euo pipefail
: "${OWNER:?}" "${FACTORY:?}"
FUNDERS="${FUNDERS:-8}"
RES="$(dirname "$0")/../contract/res"
NET=(network-config testnet)

near account create-account sponsor-by-faucet-service "$FACTORY" \
  autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain "${NET[@]}" create

for i in $(seq 1 "$FUNDERS"); do
  FUNDER="${FACTORY%.testnet}-fund$i.testnet"
  near account create-account sponsor-by-faucet-service "$FUNDER" \
    autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain "${NET[@]}" create
  sleep 3
  near account delete-account "$FUNDER" beneficiary "$FACTORY" "${NET[@]}" sign-with-keychain send
done

# The vault code hash is base58(sha256(banbo.wasm)), the same value explorers show.
HASH="$(node -e 'const a="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=BigInt("0x"+require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex")),s="";while(n>0n){s=a[Number(n%58n)]+s;n/=58n}console.log(s)' "$RES/banbo.wasm")"
echo "Vault code hash: $HASH"

near contract deploy "$FACTORY" use-file "$RES/banbo_factory.wasm" with-init-call new \
  json-args "{\"owner\":\"$OWNER\",\"vault_code_hash\":\"$HASH\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' "${NET[@]}" sign-with-keychain send

# Publish banbo.wasm as a global contract (paid from the factory's balance).
near contract call-function as-transaction "$FACTORY" publish_vault_code file-args "$RES/banbo.wasm" \
  prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" "${NET[@]}" sign-with-keychain send

near contract call-function as-read-only "$FACTORY" get_info json-args '{}' "${NET[@]}" now
echo "Done. Create a vault at https://mhiah.github.io/Banbo/#/new"
