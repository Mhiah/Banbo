.PHONY: setup build reproducible-build verify-build test test-contract test-sandbox test-dashboard test-tee-agent test-mcp demo sandbox dashboard mcp

setup:            ## install demo deps + NEAR sandbox node, dashboard, TEE agent and MCP server deps
	cd demo && npm install
	cd dashboard && npm install
	cd tee-agent && npm ci
	cd mcp && npm ci

build:            ## quick local wasm build with your own Rust toolchain (not byte-identical)
	./contract/build.sh

reproducible-build: ## rebuild contract/res/banbo.wasm in the pinned Docker image
	./scripts/reproducible-build.sh

verify-build:     ## check the committed wasm matches the source (needs Docker)
	./scripts/reproducible-build.sh --check

test-contract:    ## Rust unit tests
	cd contract && cargo test

test-sandbox:     ## integration tests on a local NEAR node (needs tee-agent and mcp deps too)
	cd demo && npm test

test-dashboard:   ## dashboard unit tests
	cd dashboard && npx vitest run

test-tee-agent:   ## TEE agent unit tests
	cd tee-agent && npm test

test-mcp:         ## MCP server unit tests
	cd mcp && npm test

test: test-contract test-sandbox test-dashboard test-tee-agent test-mcp

demo:             ## the 8-act demo (uses Claude if ANTHROPIC_API_KEY is set)
	cd demo && npm run demo

sandbox:          ## local NEAR node + seeded vault + API for the dashboard
	cd demo && npm run sandbox

dashboard:        ## owner dashboard on http://localhost:5173
	cd dashboard && npm run dev

mcp:              ## run the MCP server on stdio (configure with BANBO_* variables, see mcp/README.md)
	cd mcp && npm start
