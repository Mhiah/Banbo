# Judging Banbo

Banbo is the security layer for AI agent wallets. An agent pays from a NEAR vault contract, and the contract decides every payment. Beyond limits and an allowlist, it checks **who said so**: under a task mandate, a recipient taken from an email is refused, and an amount taken from an untrusted email is held for the owner. This follows CaMeL ([arXiv 2503.18813](https://arxiv.org/abs/2503.18813)), with the policy enforced on-chain instead of inside the agent.

This page is the shortest path to checking that claim yourself.

## 1. Look at the live vault (no install)

Open **[the demo vault on the live dashboard](https://mhiah.github.io/Banbo/#/overview?vault=vault.banbo-mia.testnet)**. It reads the testnet vault `vault.banbo-mia.testnet` straight from the chain, no wallet needed. Anyone can look; only the owner's wallet can change anything.

- **Overview**: treasury, daily budget, agents.
- **Agents** and **Spending Rules**: the limits the contract enforces for each agent.
- **Mandates**: task mandates and whose origin labels the contract accepts.
- **Activity**: every payment and every blocked attempt, with the rule that decided it.

With a testnet wallet you can also create your own vault (**+ Create a vault**) and connect an agent to it (**Agents → Connect a new agent**).

## 2. Run the attack locally

Needs Node 20+ on Linux x86_64 or macOS on Apple Silicon (on Windows, use WSL). No NEAR account and no Rust: the contract wasm is committed, and the demo starts its own local NEAR node.

```bash
git clone https://github.com/Mhiah/Banbo && cd Banbo
make setup   # installs dependencies and a local NEAR node
make demo    # eight acts, every payment a real transaction on the local node
```

What to look for in **Act 1 (invoice fraud)**. Acme and Globex are both approved vendors. A real invoice from `billing@acme.com` says 0.30 NEAR; a forged "correction" from `billing@acme-billing.co` says 0.45 NEAR, payable to Globex.

| | Ordinary firewall (limits + allowlist) | Banbo (task mandate + origin check) |
|---|---|---|
| Real invoice, 0.30 to Acme | Paid | **Paid** |
| Forged 0.45 from acme-billing.co | Paid | **Held for the owner**, with the email's sha256 |
| "Pay Globex instead" | Paid | **Refused on-chain** (`recipient_from_untrusted_source`) |

The ordinary firewall is the same vault with only its limits and allowlist, and the demo shows it paying Globex first. Without `ANTHROPIC_API_KEY`, the reader is scripted and fully fooled by the forgery, which is the point: the contract must not depend on the model resisting. With the key set, Claude plays the planner and reader.

Act 2 is the crude version (an invoice with hidden instructions to send 9 NEAR to `attacker.test.near`); Acts 3 to 8 cover failed transfers and refunds, owner approval, USDC, pay-per-call APIs, risk rules and private mode. A transaction log is written to `demo/out/demo-report.json`.

## 3. Check the claims

| Claim | Where to look | How to check |
|---|---|---|
| The contract, not the agent, makes the origin decision | `contract/src/lib.rs` (`request_payment`, task and origin checks) | `make test-contract` (131 vault + 3 factory unit tests) |
| The agent can't move money any other way | Its key is a function-call access key for `request_payment` only | `make test-sandbox`: an agent with only that key fails to transfer NEAR or call admin methods |
| A failed transfer is refunded exactly once | `on_payout` callback | `make test-sandbox` (a real failed transfer on the local node), Act 3 |
| The model can't fake an origin label | `mcp/` derives labels itself (DKIM check, amount must appear in the signed email) | `make test-mcp` |
| The CaMeL runtime labels every value | `tee-agent/src/origin/` (planner, quarantined reader, interpreter) | `make test-tee-agent`, and the origin runtime against the real contract in `make test-sandbox` |
| The TEE quote is verified on-chain | `contract/src/tee.rs`, tested with a genuine Intel TDX quote | `make test-contract` |
| The deployed code is the published source | Reproducible Docker build, pinned by digest | `make verify-build` (needs Docker); `scripts/reproducible-build.sh --account vault.banbo-mia.testnet` |
| Factory vaults all run the same, unchangeable code | `contract/factory` uses a NEAR global contract by code hash | `contract/factory` unit tests and `demo/test/factory.test.js` |

`make test` runs all of it (48 sandbox integration tests on top of the unit tests).

## 4. Use it from an agent

The [MCP server](mcp/README.md) lets Claude Desktop, Claude Code, Cursor or any MCP agent pay through a vault. It refuses to start with a full-access key, and it reports a payment as paid only after the network confirms it.

## What is not done yet

We'd rather you read this here than find it yourself. The full list is in [README → Limitations](README.md#limitations).

- Testnet only, unaudited. Don't put real funds in it.
- The TEE agent has been tested with a genuine Intel TDX quote verified on-chain, but not yet deployed in a live TDX VM. The demo uses owner vouching instead.
- The origin runtime has been tested end to end with scripted models; runs with a live model still need checking.
- Private mode hides the vendor list and memos, not payments: amounts and recipients of made payments are public.

## Where things are

- [README.md](README.md): the full story, architecture and contract API
- [docs/ORIGIN_CHECKS.md](docs/ORIGIN_CHECKS.md): the CaMeL design and exactly what the contract enforces
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): threats, mitigations and the security review
- [docs/PRIVACY.md](docs/PRIVACY.md): private mode and its trust assumptions
- [llms.txt](llms.txt): the same map, for AI reviewers
