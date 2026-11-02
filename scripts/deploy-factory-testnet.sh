#!/usr/bin/env bash
# Deploy the Banbo factory to NEAR testnet and publish the vault code once, so
# anyone can create a vault from the dashboard with one wallet transaction.
# Needs near-cli-rs and an owner account in your keychain. Usage:
#   OWNER=you.testnet FACTORY=banbo-vaults.testnet ./scripts/deploy-factory-testnet.sh
#
# Publishing global code burns 10x the normal storage cost: about 77 NEAR for
# banbo.wasm. The faucet gives 10 test NEAR per new account, so this creates
# throwaway faucet accounts and deletes each one into the factory (moving its
# whole balance there) until the factory holds TARGET_NEAR (default 82).
set -euo pipefail
: "${OWNER:?}" "${FACTORY:?}"
TARGET_NEAR="${TARGET_NEAR:-82}"
RES="$(dirname "$0")/../contract/res"
NET=(network-config testnet)
RPC="${RPC:-https://test.rpc.fastnear.com}"

# Public RPC nodes rate-limit; wait and try again instead of stopping. Safe to
# re-run the whole script: it skips what's already done.
retry() {
  for n in 1 2 3 4 5 6; do
    "$@" && return 0
    echo "  ...failed (attempt $n), waiting 30s and trying again" >&2; sleep 30
  done
  return 1
}
# Balance in whole NEAR, or -1 if the account doesn't exist.
balance() {
  curl -s -m 15 -X POST "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d);if(r.error&&/UNKNOWN_ACCOUNT|does not exist/.test(JSON.stringify(r.error))){console.log(-1);return}if(!r.result)throw 0;console.log(Number(BigInt(r.result.amount)/10n**24n))}catch{console.log("?")}})'
}
# The account's code hash, or "none".
code_of() {
  curl -s -m 15 -X POST "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const h=JSON.parse(d).result.code_hash;console.log(h==="11111111111111111111111111111111"?"none":h)}catch{console.log("none")}})'
}
known_balance() { local b; for n in 1 2 3 4 5 6; do b="$(balance "$1")"; [ "$b" != "?" ] && { echo "$b"; return; }; sleep 20; done; echo "can't read $1 from $RPC" >&2; exit 1; }

# Already deployed and the ~77 NEAR publish already spent: nothing left to do.
start="$(known_balance "$FACTORY")"
if [ "$(code_of "$FACTORY")" != none ] && [ "$start" -lt 20 ]; then
  echo "$FACTORY is deployed and the vault code is already published."
  near contract call-function as-read-only "$FACTORY" get_info json-args '{}' "${NET[@]}" now
  exit 0
fi

if [ "$start" = -1 ]; then
  retry near account create-account sponsor-by-faucet-service "$FACTORY" \
    autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain "${NET[@]}" create
  sleep 10
fi

i=0
while true; do
  have="$(known_balance "$FACTORY")"
  [ "$have" -ge "$TARGET_NEAR" ] && break
  i=$((i + 1)); [ "$i" -le 20 ] || { echo "faucet funding stopped after 20 accounts" >&2; exit 1; }
  FUNDER="${FACTORY%.testnet}-fund$i.testnet"
  echo "Factory has $have NEAR of $TARGET_NEAR; funding from $FUNDER"
  fb="$(known_balance "$FUNDER")"
  if [ "$fb" = -1 ]; then
    retry near account create-account sponsor-by-faucet-service "$FUNDER" \
      autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain "${NET[@]}" create
    sleep 10
  fi
  retry near account delete-account "$FUNDER" beneficiary "$FACTORY" "${NET[@]}" sign-with-keychain send
  sleep 10
done

# The vault code hash is base58(sha256(banbo.wasm)), the same value explorers show.
HASH="$(node -e 'const a="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=BigInt("0x"+require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex")),s="";while(n>0n){s=a[Number(n%58n)]+s;n/=58n}console.log(s)' "$RES/banbo.wasm")"
echo "Vault code hash: $HASH"

[ "$(code_of "$FACTORY")" != none ] || retry near contract deploy "$FACTORY" use-file "$RES/banbo_factory.wasm" with-init-call new \
  json-args "{\"owner\":\"$OWNER\",\"vault_code_hash\":\"$HASH\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' "${NET[@]}" sign-with-keychain send

# Publish banbo.wasm as a global contract (paid from the factory's balance).
# Not retried automatically: if this fails, re-run the script; it checks first.
sleep 10
near contract call-function as-transaction "$FACTORY" publish_vault_code file-args "$RES/banbo.wasm" \
  prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" "${NET[@]}" sign-with-keychain send

near contract call-function as-read-only "$FACTORY" get_info json-args '{}' "${NET[@]}" now
echo "Done. Create a vault at https://mhiah.github.io/Banbo/#/new"
