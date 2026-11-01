# AtomicGuard

**An agent wallet firewall on NEAR.** AI agents can pay for things from a shared treasury, but they never hold the treasury's keys. Every payment goes through a NEAR contract that enforces the owner's rules, even when the agent has been prompt-injected.

Built at NEAR HACKATHON (Nov 2026). Tracks: **AI Security & Defense**, Agent Economy.

## The problem

Agents read untrusted content all day: web pages, emails, invoices, API responses. One hidden line of text can turn a helpful payments agent into one that sends the treasury to an attacker. Telling the model to be careful isn't a security boundary.

AtomicGuard puts the boundary on-chain:

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

The demo starts a real local NEAR node, deploys the contract and runs three acts. Every payment is a real transaction.

1. **Prompt injection.** An accounts-payable agent is asked to pay [an invoice](demo/fixtures/invoice.html) that hides instructions to move 9 NEAR to `attacker.test.near`. The attacker gets nothing, and the real 0.2 NEAR invoice still gets paid.
2. **A transfer fails after approval.** The recipient no longer exists, so the transfer fails a block later. The callback releases the budget exactly once, the refund returns to the vault, and a retry with the same id is a no-op.
3. **Big payments need a human.** A payment over the agent's threshold waits until the owner approves it.

With `ANTHROPIC_API_KEY` set, Act 1 is driven by a real Claude agent whose only payment tool is the vault. Without a key (or with `npm run demo:scripted`), a scripted compromised agent makes the same attempts. If the model spots the injection and refuses, the demo replays the attack as a compromised agent anyway, because the vault must not depend on the model resisting.

A transaction log is written to `demo/out/demo-report.json`.

## How it works

```
agent (function-call key: vault.request_payment only)
   │ request_payment(id, recipient, amount, memo)
   ▼
AtomicGuard contract
   1. policy check: agent active, not paused, recipient allowlisted,
      ≤ per-request max, agent + shared budget, vault balance
      └─ fail → returns {outcome: "rejected", reason}, logs event, writes nothing
   2. reserve amount against agent + shared budget
   3a. ≤ approval threshold → Promise transfer ──then──► on_payout (private)
   3b. > threshold → PendingApproval until owner approve()/decline()
   ▼
on_payout: success → reserved moves to spent (Settled)
           failure → reservation released (Failed); protocol refunds the deposit
```

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
| `request_payment(request_id, recipient, amount, memo?)` | agent | the only spend path |
| `on_payout(key)` | contract only | `#[private]` callback |
| `get_config`, `get_agent`, `list_agents`, `list_allowlist`, `get_request`, `list_requests`, `get_balances` | view | |

Amounts are yoctoNEAR strings. Events are emitted as NEP-297 logs (`EVENT_JSON:{"standard":"atomicguard",...}`).

## Tests

```bash
make test-contract   # 20 Rust unit tests (policy, invariants, callbacks, periods)
make test-sandbox    # 9 integration tests on a local NEAR node
```

The sandbox tests cover what unit tests can't: a real failed transfer and refund, `#[private]` enforcement, and an agent that holds only a function-call key failing to transfer NEAR or call admin methods.

## Repo layout

```
contract/            Rust contract (near-sdk 5)
  src/lib.rs         vault logic
  src/tests.rs       unit tests
  build.sh           wasm build without cargo-near
  res/               prebuilt atomicguard.wasm (so the demo runs without Rust)
demo/
  src/vault.js       sandbox setup helpers
  src/agent.js       Claude agent + scripted compromised agent
  src/demo.js        the 3-act demo
  test/              sandbox integration tests
  fixtures/          the poisoned invoice
scripts/
  deploy-testnet.sh  deploy + give an agent a restricted key on testnet
docs/THREAT_MODEL.md
```

## Building the contract

`contract/res/atomicguard.wasm` is committed. To rebuild (Rust stable with the `wasm32-unknown-unknown` target, and `make setup` first for `wasm-opt`):

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
