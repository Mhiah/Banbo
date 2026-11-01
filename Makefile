.PHONY: setup build test test-contract test-sandbox demo

setup:            ## install demo deps + NEAR sandbox node
	cd demo && npm install

build:            ## rebuild contract/res/banbo.wasm (needs Rust)
	./contract/build.sh

test-contract:    ## Rust unit tests
	cd contract && cargo test

test-sandbox:     ## integration tests on a local NEAR node
	cd demo && npm test

test: test-contract test-sandbox

demo:             ## the 3-act demo (uses Claude if ANTHROPIC_API_KEY is set)
	cd demo && npm run demo
