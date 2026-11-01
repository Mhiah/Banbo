#!/usr/bin/env bash
# Runs inside the docker/Dockerfile image with the repo's contract/ mounted
# read-only at /build/contract; writes /out/banbo.wasm.
set -euo pipefail
cd /build/contract
export CARGO_TARGET_DIR=/tmp/target
# Crate downloads go to a scratch cargo home; the toolchain stays the image's.
TOOLCHAIN_HOME="$(dirname "$(dirname "$(command -v cargo)")")"
export CARGO_HOME=/tmp/cargo-home
export RUSTFLAGS="--cfg near -C target-cpu=mvp -C link-arg=-s \
  --remap-path-prefix=/build=/banbo --remap-path-prefix=/tmp/cargo-home=/cargo \
  --remap-path-prefix=${TOOLCHAIN_HOME}=/cargo"
cargo build --locked --release --target wasm32-unknown-unknown
wasm-opt -Oz --signext-lowering --llvm-memory-copy-fill-lowering \
  --enable-bulk-memory --enable-sign-ext \
  /tmp/target/wasm32-unknown-unknown/release/banbo.wasm -o /out/banbo.wasm
