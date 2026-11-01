# Banbo: the wallet firewall for AI agents

**Enforced by the contract, not the prompt.**

Banbo is a wallet firewall for AI agents on NEAR. AI agents can pay for things from a shared treasury, but they never hold the treasury's keys. Every payment goes through a NEAR contract that enforces the owner's rules, even when the agent has been prompt-injected.

Built at NEAR HACKATHON (Nov 2026). Tracks: **AI Security & Defense**, Agent Economy.

## The problem

Agents read untrusted content all day: web pages, emails, invoices, API responses. One hidden line of text can turn a helpful payments agent into one that sends the treasury to an attacker. Telling the model to be careful isn't a security boundary.

Banbo puts the boundary on-chain:

| Attack | What stops it |
|---|---|
| Injected "send everything to attacker.near" | Recipient allowlist, enforced by the contract |
| "Prepay the vendor 12 months" | Per-request maximum |
| Many small payments | Per-agent daily limit, plus a shared daily cap across all agents |
| Agent tries to transfer NEAR directly or call admin methods | The agent's key is a **function-call access key** that can only call `request_payment` |
| Large legitimate-looking payment | Held for **owner approval** above a threshold |
| Transfer fails after approval | Reservation released exactly once in the async callback, refund lands back in the vault |
| Agent retries a request | Request ids are idempotent: a retry never pays twice |
| Agent goes rogue | Owner can disable that agent or pause the whole vault instantly |

## Demo

```bash
make setup   # npm install + a local NEAR sandbox node (no testnet account needed)
make demo
```

The demo starts a real local NEAR node, deploys the contract and runs six acts. Every payment is a real transaction.

1. **Prompt injection.** An accounts-payable agent is asked to pay [an invoice](demo/fixtures/invoice.html) that hides instructions to move 9 NEAR to `attacker.test.near`. The attacker gets nothing, and the real 0.2 NEAR invoice still gets paid.
2. **A transfer fails after approval.** The recipient no longer exists, so the transfer fails a block later. The callback releases the budget exactly once, the refund returns to the vault, and a retry with the same id is a no-op.
3. **Big payments need a human.** A payment over the agent's threshold waits until the owner approves it.
4. **Paying in USDC.** An agent pays the vendor 7.50 USDC through `ft_transfer`. A second payment goes to an allowed account that never registered with the USDC contract. The vault checks registration before sending, so that payment fails safely and its budget comes back.
5. **Agents paying for what they use.** A weather API charges per call in USDC. The research agent buys three calls, each paid through the vault, and the API serves only after reading the settled payment from the contract. A 15 USDC bulk export is blocked by the agent's limit, and reused or unpaid quotes get nothing.
6. **Attacks that stay under the limits.** With risk rules on, a lookalike billing account the owner was tricked into allowing can't be paid during its 1-hour cooldown, and an agent told to pay 40 tiny line items is stopped after 5 payments that hour.

With `ANTHROPIC_API_KEY` set, Act 1 is driven by a real Claude agent whose only payment tool is the vault. Without a key (or with `npm run demo:scripted`), a scripted compromised agent makes the same attempts. If the model spots the injection and refuses, the demo replays the attack as a compromised agent anyway, because the vault must not depend on the model resisting.

A transaction log is written to `demo/out/demo-report.json`.

## Owner dashboard

The dashboard is where the vault owner watches spending and changes the rules: treasury and daily budget, agents and their limits, allowed recipients, payments waiting for approval, every blocked attempt with the rule that stopped it, and an emergency pause.

![Overview](docs/screenshots/overview.png)

Run it locally against a seeded sandbox vault:

```bash
make setup
make sandbox     # terminal 1: local NEAR node, vault, test agents, API on :3031
make dashboard   # terminal 2: http://localhost:5173
```

Everything on screen is read from the contract every 2 seconds. A change shows as done only after the transaction is confirmed on chain. On the sandbox, owner actions are signed by the sandbox process, so keys never reach the browser. On testnet and mainnet you connect the owner wallet (Meteor, MyNearWallet, HERE or Intear) and sign each change yourself. The **Demo** page (sandbox only) runs the prompt-injection attack and the other scenarios as real transactions.

| Activity | On a phone |
| --- | --- |
| ![Activity](docs/screenshots/activity.png) | ![Activity on mobile](docs/screenshots/activity-mobile.png) |

## How it works

```
agent (function-call key: vault.request_payment only)
   │ request_payment(id, recipient, amount, memo)
   ▼
Banbo contract
   1. policy check: agent active, not paused, recipient allowlisted,
      ≤ per-request max, agent + shared budget, vault balance
      └─ fail → returns {outcome: "rejected", reason}, logs event, writes nothing
   2. reserve amount against agent + shared budget
   3a. ≤ approval threshold → Promise transfer ──then──► on_payout (private)
       (USDC: storage_balance_of ──then──► on_recipient_checked ──► ft_transfer ──then──► on_payout)
   3b. > threshold → PendingApproval until owner approve()/decline()
   ▼
on_payout: success → reserved moves to spent (Settled)
           failure → reservation released (Failed); protocol refunds the deposit
```

### Risk rules

Amount limits alone leave two gaps: an attacker can get the owner to allow their account, and many small payments can add up under every limit. `set_risk_rules(recipient_cooldown_ms, max_payments_per_hour)` closes both (both off by default):

- **New recipient cooldown.** A recipient allowed while a cooldown is set can't be paid until it has passed (`recipient_in_cooldown`), which gives the owner time to spot and remove it. Recipients keep the cooldown they were added under, and lowering the cooldown releases them sooner. `list_recipients` shows when each one becomes payable.
- **Payments per agent per hour.** Each agent may make at most this many payment requests in a one-hour window (`exceeds_payment_rate`). Rejected and duplicate requests don't count.

### Paying for APIs (Agent Economy)

[`demo/src/paid-api.js`](demo/src/paid-api.js) is a pay-per-call API that answers only after a Banbo vault has paid it, plus the client an agent uses to call it:

1. The agent calls an endpoint. The API answers `402 Payment Required` with a quote: price, token, recipient (the vendor), the vault, and a one-time quote id.
2. The agent calls `request_payment` with `request_id = quote.id`. The vault applies all of the agent's rules, so an over-budget purchase is blocked before anything is paid.
3. The agent retries with `x-banbo-payment: <agent account>:<quote id>`. The vendor holds no keys and trusts no headers: it reads `get_request` from the vault contract and serves only if that payment has settled to the vendor for at least the quoted amount and token. Each quote works for one endpoint, one time.

The agent won't pay a quote that names a different vault. With `ANTHROPIC_API_KEY` set, a Claude research agent decides which calls to buy (`call_paid_api` tool); otherwise a script makes the same purchases. The sandbox runs this API on `http://localhost:3032`.

### USDC and other NEP-141 tokens

Agents can pay in a NEP-141 token such as USDC as well as NEAR. Each token has its own shared daily cap, and each agent has separate limits per token, so USDC spending never uses up the NEAR budget or the other way round. An agent with no limits for a token can't pay in it.

- **Funding:** send tokens with `ft_transfer_call` to the vault. It only accepts tokens the owner added with `add_token` and refunds anything else. The vault tracks its own token balance and never counts tokens that are reserved or held for approval as available.
- **Paying:** `request_payment(..., token: "<token contract>")`. The vault reserves the amount, checks with `storage_balance_of` that the recipient can receive the token, then sends `ft_transfer` (1 yoctoNEAR attached, as NEP-141 requires) and reconciles in the same `on_payout` callback. If the recipient isn't registered, or the transfer fails, the request ends as `Failed` with a `failure_reason`, and the budget and tokens are restored exactly once.
- **Real USDC:** Circle's native USDC is `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` on mainnet and `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` on testnet ([Circle's list](https://developers.circle.com/stablecoins/usdc-contract-addresses)). The vault must be registered with it (`storage_deposit`) before it can receive USDC. `WITH_USDC=1 ./scripts/deploy-testnet.sh` does the setup on testnet. The local sandbox uses a test-only token (`contract/mock-ft`) instead.

**Invariant**, per agent and for the shared treasury in the current period: `spent + reserved ≤ limit`, and every request settles at most once. When a new period starts, `spent` resets but in-flight reservations carry over.

A note on concurrency: NEAR executes calls to one contract one at a time, so two requests can't race on the same balance check. The hard part on NEAR is the gap between sending a transfer and learning its result, while other requests keep arriving. That's why the contract reserves before sending and reconciles in a callback.

### Contract API

| Method | Who | |
|---|---|---|
| `new(owner, period_ms, shared_cap)` | deployer | init |
| `deposit()` | anyone | payable top-up |
| `add_agent(agent, per_tx_max, period_limit, approval_threshold)` | owner | register or update |
| `set_agent_active(agent, active)` | owner | kill switch per agent |
| `allow_recipient` / `disallow_recipient` | owner | allowlist |
| `pause` / `unpause`, `set_shared_cap`, `withdraw(amount)` | owner | withdraw can't touch reserved funds |
| `approve(key)` / `decline(key)` | owner | pending payments |
| `add_token(token, symbol, decimals, shared_cap)` | owner | accept a NEP-141 token, or update its cap |
| `set_agent_token_limits(agent, token, per_tx_max, period_limit, approval_threshold)` | owner | what an agent may spend in a token |
| `withdraw_token(token, amount)` | owner | can't touch reserved tokens; restored if the transfer fails |
| `ft_on_transfer(sender_id, amount, msg)` | token contract | NEP-141 deposit; unknown tokens are refunded |
| `set_risk_rules(recipient_cooldown_ms, max_payments_per_hour)` | owner | 0 turns a rule off |
| `request_payment(request_id, recipient, amount, memo?, token?)` | agent | the only spend path; `token` omitted means NEAR |
| `on_payout(key)`, `on_recipient_checked(key)`, `on_token_withdraw(...)` | contract only | `#[private]` callbacks |
| `get_config`, `get_agent`, `list_agents`, `list_allowlist`, `get_request`, `list_requests`, `list_blocked`, `blocked_count`, `get_balances`, `list_tokens`, `get_agent_token_limits`, `list_recipients`, `get_agent_rate` | view | |

NEAR amounts are yoctoNEAR strings; token amounts are in the token's smallest unit (USDC has 6 decimals). Events are emitted as NEP-297 logs (`EVENT_JSON:{"standard":"banbo",...}`).

## Tests

```bash
make test-contract   # 40 Rust unit tests (policy, invariants, callbacks, periods, tokens, risk rules)
make test-sandbox    # 21 integration tests on a local NEAR node: payments, USDC, the paid API, risk rules
```

The sandbox tests cover what unit tests can't: a real failed transfer and refund, `#[private]` enforcement, and an agent that holds only a function-call key failing to transfer NEAR or call admin methods.

## Repo layout

```
contract/            Rust contract (near-sdk 5)
  src/lib.rs         vault logic
  src/tests.rs       unit tests
  build.sh           wasm build without cargo-near
  mock-ft/           test-only NEP-141 token used as USDC on the sandbox
  res/               prebuilt banbo.wasm and mock_ft.wasm (so the demo runs without Rust)
demo/
  src/vault.js       sandbox setup helpers
  src/agent.js       Claude agent + scripted compromised agent
  src/demo.js        the 6-act demo
  src/sandbox.js     long-running sandbox + local API for the dashboard
  src/paid-api.js    pay-per-call API that verifies vault payments on-chain, and its client
  test/              sandbox integration tests
  fixtures/          the poisoned invoice
dashboard/           owner dashboard (Vite + React)
scripts/
  deploy-testnet.sh  deploy + give an agent a restricted key on testnet
docs/THREAT_MODEL.md
```

## Building the contract

`contract/res/banbo.wasm` is committed. To rebuild (Rust stable with the `wasm32-unknown-unknown` target, and `make setup` first for `wasm-opt`):

```bash
make build
```

## Deploying to testnet

Needs [near-cli-rs](https://github.com/near/near-cli-rs) and a funded testnet account:

```bash
OWNER=you.testnet VAULT=vault.you.testnet AGENT=agent.you.testnet VENDOR=vendor.testnet \
  ./scripts/deploy-testnet.sh
```

## Troubleshooting

- **The sandbox fails with "couldn't set the file descriptor limit"**: run `ulimit -n 65535` first. In containers where the hard limit is lower, the node can't start.
- **Deploy fails with "unknown import"**: the sandbox node is older than the SDK. `npm install` runs `scripts/fetch-sandbox.mjs`, which installs nearcore 2.14.0. Rerun it if needed.

## Limitations

- Native NEAR only for now. NEP-141 stablecoins are next.
- The allowlist is the main defense against new recipients. It doesn't judge whether a payment to an allowlisted vendor is sensible beyond the limits.
- If the callback itself ran out of gas, a request would stay `InFlight`. The callback has a fixed 10 Tgas budget and does very little, but there is no manual recovery method yet.
- Testnet only, unaudited. Don't put real funds in it.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## License

MIT
