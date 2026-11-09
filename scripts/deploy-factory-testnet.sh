#!/usr/bin/env bash
# Deploy the Banbo factory to NEAR testnet (or mainnet) and give it the vault
# code, so anyone can create a vault from the dashboard with one wallet
# transaction. Needs near-cli-rs and a funded account in your keychain. Usage:
#   OWNER=you.testnet FACTORY=banbo-vaults.testnet ./scripts/deploy-factory-testnet.sh
# Mainnet (real NEAR): NETWORK=mainnet OWNER=you.near FACTORY=banbo-vaults.near
#
# The factory stores one copy of banbo.wasm (about 7.7 NEAR of storage) plus its
# own code (about 1.4 NEAR), so it needs about 10 NEAR. FUNDER (default OWNER)
# pays: it creates the factory account if it doesn't exist, or tops it up.
set -euo pipefail
: "${OWNER:?}" "${FACTORY:?}"
FUNDER="${FUNDER:-$OWNER}"
TARGET_NEAR="${TARGET_NEAR:-10.5}"
RES="$(dirname "$0")/../contract/res"
NETWORK="${NETWORK:-testnet}"
case "$NETWORK" in testnet|mainnet) ;; *) echo "NETWORK must be testnet or mainnet" >&2; exit 1;; esac
NET=(network-config "$NETWORK")
if [ "$NETWORK" = mainnet ]; then DEF_RPC=https://rpc.mainnet.fastnear.com; else DEF_RPC=https://test.rpc.fastnear.com; fi
RPC="${RPC:-$DEF_RPC}"

# Public RPC nodes rate-limit; wait and try again instead of stopping. Safe to
# re-run the whole script: it skips what's already done.
retry() {
  for n in 1 2 3 4 5 6; do
    "$@" && return 0
    echo "  ...failed (attempt $n), waiting 30s and trying again" >&2; sleep 30
  done
  return 1
}
# view_account field ($2) of account $1, "missing" if it doesn't exist, "?" if unreadable.
account_field() {
  curl -s -m 15 -X POST "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d);if(r.error&&/UNKNOWN_ACCOUNT|does not exist/.test(JSON.stringify(r.error))){console.log("missing");return}if(!r.result)throw 0;console.log(r.result[process.argv[1]])}catch{console.log("?")}})' "$2"
}
read_field() { local v; for n in 1 2 3 4 5 6; do v="$(account_field "$1" "$2")"; [ "$v" != "?" ] && { echo "$v"; return; }; sleep 20; done; echo "can't read $1 from $RPC" >&2; exit 1; }
# Balance in NEAR (decimal), or "missing".
near_balance() { local y; y="$(read_field "$1" amount)"; [ "$y" = missing ] && { echo missing; return; }; node -e 'console.log((Number(BigInt(process.argv[1])/10n**20n)/1e4).toFixed(4))' "$y"; }
lt() { node -e 'process.exit(Number(process.argv[1]) < Number(process.argv[2]) ? 0 : 1)' "$1" "$2"; }

# The vault code hash is base58(sha256(banbo.wasm)), the same value explorers show.
HASH="$(node -e 'const a="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=BigInt("0x"+require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex")),s="";while(n>0n){s=a[Number(n%58n)]+s;n/=58n}console.log(s)' "$RES/banbo.wasm")"
echo "Vault code hash: $HASH"

have="$(near_balance "$FACTORY")"
if [ "$have" = missing ]; then
  echo "Creating $FACTORY with $TARGET_NEAR NEAR from $FUNDER"
  retry near account create-account fund-myself "$FACTORY" "$TARGET_NEAR NEAR" \
    autogenerate-new-keypair save-to-keychain sign-as "$FUNDER" "${NET[@]}" sign-with-keychain send
  sleep 10
else
  echo "$FACTORY has $have NEAR"
  if [ "$(read_field "$FACTORY" code_hash)" = 11111111111111111111111111111111 ] && lt "$have" "$TARGET_NEAR"; then
    top="$(node -e 'console.log((Number(process.argv[1]) - Number(process.argv[2]) + 0.01).toFixed(2))' "$TARGET_NEAR" "$have")"
    echo "Topping up $FACTORY with $top NEAR from $FUNDER"
    retry near tokens "$FUNDER" send-near "$FACTORY" "$top NEAR" "${NET[@]}" sign-with-keychain send
    sleep 10
  fi
fi

if [ "$(read_field "$FACTORY" code_hash)" = 11111111111111111111111111111111 ]; then
  retry near contract deploy "$FACTORY" use-file "$RES/banbo_factory.wasm" with-init-call new \
    json-args "{\"owner\":\"$OWNER\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' "${NET[@]}" sign-with-keychain send
  sleep 10
fi

# Store banbo.wasm in the factory (paid from the factory's balance). Skipped if
# the factory already holds this exact code.
if near contract call-function as-read-only "$FACTORY" get_info json-args '{}' "${NET[@]}" now 2>/dev/null | grep -q "$HASH"; then
  echo "The factory already holds this vault code."
else
  retry near contract call-function as-transaction "$FACTORY" set_vault_code file-args "$RES/banbo.wasm" \
    prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" "${NET[@]}" sign-with-keychain send
  sleep 5
fi

near contract call-function as-read-only "$FACTORY" get_info json-args '{}' "${NET[@]}" now
echo "Done. Create a vault at https://banbo.myacxt.site/ ($NETWORK)"
