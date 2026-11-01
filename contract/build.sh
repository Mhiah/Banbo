#!/usr/bin/env bash
# Builds a NEAR-compatible wasm without needing cargo-near.
#  --cfg near           : tells near-sdk it is running on-chain (host calls, panic messages)
#  -C target-cpu=mvp    : avoid wasm features older NEAR runtimes reject
# wasm-opt then lowers the remaining post-MVP ops and shrinks the binary.
set -euo pipefail
cd "$(dirname "$0")"
RUSTFLAGS="--cfg near -C target-cpu=mvp -C link-arg=-s" \
  cargo build --release --target wasm32-unknown-unknown
mkdir -p res
WASM_OPT="${WASM_OPT:-../demo/node_modules/.bin/wasm-opt}"
"$WASM_OPT" -Oz --signext-lowering --llvm-memory-copy-fill-lowering \
  --enable-bulk-memory --enable-sign-ext \
  target/wasm32-unknown-unknown/release/banbo.wasm -o res/banbo.wasm
# Test-only NEP-141 token that stands in for USDC on the local sandbox.
(cd mock-ft && RUSTFLAGS="--cfg near -C target-cpu=mvp -C link-arg=-s" \
  cargo build --release --target wasm32-unknown-unknown)
"$WASM_OPT" -Oz --signext-lowering --llvm-memory-copy-fill-lowering \
  --enable-bulk-memory --enable-sign-ext \
  mock-ft/target/wasm32-unknown-unknown/release/mock_ft.wasm -o res/mock_ft.wasm
ls -la res/
