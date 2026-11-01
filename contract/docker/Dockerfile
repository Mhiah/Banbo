# syntax=docker/dockerfile:1
# Reproducible build environment for the Banbo contract.
# Everything that affects the output bytes is pinned: the base image (NEAR's
# cargo-near build image with Rust 1.97.1 and clang 19, by digest), every
# crate (Cargo.lock) and binaryen's wasm-opt (by version and checksum). Paths
# are fixed and remapped so the wasm doesn't depend on where you cloned the repo.
FROM sourcescan/cargo-near@sha256:7467038bdddc86484b73b416eeadce926ff59013e128e53dec5a19e1cb4b2234

USER root
# wasm-opt from binaryen's official release, checked against its published sha256.
ADD --checksum=sha256:195ddc94f9bc89f45abdabb0b9eea86023d727ba90eac8b35b80f2544fc30572 \
    https://github.com/WebAssembly/binaryen/releases/download/version_132/binaryen-version_132-x86_64-linux.tar.gz \
    /tmp/binaryen.tgz
RUN tar -xzf /tmp/binaryen.tgz -C /opt \
 && ln -s /opt/binaryen-version_132/bin/wasm-opt /usr/local/bin/wasm-opt \
 && rm /tmp/binaryen.tgz
USER near
ENV SOURCE_DATE_EPOCH=0
WORKDIR /build/contract
