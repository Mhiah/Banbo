#!/usr/bin/env bash
# Build the contract in a pinned Docker image and print its code hash.
#
#   scripts/reproducible-build.sh            build, write contract/res/banbo.wasm
#   scripts/reproducible-build.sh --check    build, fail if it differs from the committed wasm
#   scripts/reproducible-build.sh --account banbo.near [--network mainnet]
#                                            build, compare with the code deployed on that account
#                                            (factory vaults too)
#
# NEAR's code hash is base58(sha256(wasm)), the same value explorers show.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE=write; ACCOUNT=""; NETWORK=testnet
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --account) ACCOUNT="$2"; MODE=account; shift ;;
    --network) NETWORK="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

IMAGE=banbo-contract-build
# Behind a proxy (HTTPS_PROXY on this machine) the build uses host networking;
# BUILD_CA_BUNDLE adds a proxy's CA certificate. Neither changes the output.
NET=(); CA_BUILD=(); CA_RUN=()
if [ -n "${HTTPS_PROXY:-}" ]; then NET=(--network host); fi
if [ -n "${BUILD_CA_BUNDLE:-}" ]; then
  CA_BUILD=(--secret "id=ca,src=$BUILD_CA_BUNDLE")
  CA_RUN=(-v "$BUILD_CA_BUNDLE:/etc/ssl/certs/ca-certificates.crt:ro" -e CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt)
fi
docker build -q "${NET[@]}" "${CA_BUILD[@]}" ${HTTPS_PROXY:+--build-arg HTTPS_PROXY --build-arg https_proxy=$HTTPS_PROXY} \
  -t "$IMAGE" "$ROOT/contract/docker" >/dev/null
OUT="$(mktemp -d)"; chmod 777 "$OUT"
trap 'rm -rf "$OUT"' EXIT
# The source is mounted read-only: the build can't change the checkout.
docker run --rm \
  -v "$ROOT/contract:/build/contract:ro" -v "$OUT:/out" \
  "${NET[@]}" "${CA_RUN[@]}" ${HTTPS_PROXY:+-e HTTPS_PROXY -e https_proxy=$HTTPS_PROXY} \
  "$IMAGE" /build/contract/docker/build-in-container.sh

hexhash() { sha256sum "$1" | cut -d' ' -f1; }
b58() { node -e 'const a="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=BigInt("0x"+process.argv[1]),s="";while(n>0n){s=a[Number(n%58n)]+s;n/=58n}console.log(s)' "$1"; }
BUILT="$OUT/banbo.wasm"
HEX="$(hexhash "$BUILT")"
echo "sha256:    $HEX"
echo "code hash: $(b58 "$HEX")"

case "$MODE" in
  write)
    cp "$BUILT" "$ROOT/contract/res/banbo.wasm"
    echo "$HEX  banbo.wasm" > "$ROOT/contract/res/banbo.wasm.sha256"
    echo "wrote contract/res/banbo.wasm" ;;
  check)
    COMMITTED="$(hexhash "$ROOT/contract/res/banbo.wasm")"
    if [ "$COMMITTED" != "$HEX" ]; then
      echo "MISMATCH: committed contract/res/banbo.wasm is $COMMITTED" >&2; exit 1
    fi
    echo "OK: matches the committed contract/res/banbo.wasm" ;;
  account)
    RPC="https://rpc.$NETWORK.near.org"
    ONCHAIN="$(curl -fsS "$RPC" -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$ACCOUNT\"}}" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d).result;console.log(r.global_contract_hash||r.code_hash)})')"
    echo "on-chain:  $ONCHAIN ($ACCOUNT on $NETWORK)"
    if [ "$ONCHAIN" != "$(b58 "$HEX")" ]; then echo "MISMATCH" >&2; exit 1; fi
    echo "OK: $ACCOUNT runs exactly this source" ;;
esac
