.PHONY: setup build test test-contract test-sandbox test-dashboard test-tee-agent demo sandbox dashboard

setup:            ## install demo deps + NEAR sandbox node, dashboard and TEE agent deps
	cd demo && npm install
	cd dashboard && npm install
	cd tee-agent && npm ci

build:            ## rebuild contract/res/banbo.wasm (needs Rust)
	./contract/build.sh

test-contract:    ## Rust unit tests
	cd contract && cargo test

test-sandbox:     ## integration tests on a local NEAR node (needs tee-agent deps too)
	cd demo && npm test

test-dashboard:   ## dashboard unit tests
	cd dashboard && npx vitest run

test-tee-agent:   ## TEE agent unit tests
	cd tee-agent && npm test

test: test-contract test-sandbox test-dashboard test-tee-agent

demo:             ## the 7-act demo (uses Claude if ANTHROPIC_API_KEY is set)
	cd demo && npm run demo

sandbox:          ## local NEAR node + seeded vault + API for the dashboard
	cd demo && npm run sandbox

dashboard:        ## owner dashboard on http://localhost:5173
	cd dashboard && npm run dev
