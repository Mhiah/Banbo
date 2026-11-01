# Threat model

## Assets
- NEAR held by the vault contract.
- The policy: agent registry, limits, allowlist, pause state.

## Actors and authority

| Actor | Can | Cannot |
|---|---|---|
| Owner (`owner` account) | Change policy, approve/decline, withdraw unreserved funds, pause | Bypass reservation accounting |
| Agent account | Call `request_payment` (with its function-call key) | Transfer NEAR, call other methods, approve its own requests |
| Vault contract | Send transfers it has reserved for | Act without a request or an owner approval |
| Anyone | `deposit`, view methods | Spend |

The agent's runtime only holds a function-call access key restricted to `vault.request_payment` with a small gas allowance. The agent account's full-access key should stay offline with the owner.

## Threats

| # | Threat | Mitigation | Tested |
|---|---|---|---|
| T1 | Prompt injection makes the agent pay an attacker | Recipient allowlist | unit + sandbox + demo |
| T2 | Injection drains via an allowlisted vendor | Per-request max, per-agent and shared period caps | unit + sandbox |
| T3 | Agent splits a large theft into many payments | Period limits count spent + reserved | unit |
| T4 | Compromised agent key used outside the vault | Function-call key: no transfers, only `request_payment` | sandbox |
| T5 | Agent calls owner methods | `owner only` checks | unit + sandbox |
| T6 | Anyone calls the payout callback to fake a settlement | `#[private]` | sandbox |
| T7 | Transfer fails, budget stays consumed or gets double-released | Explicit InFlight → Settled/Failed state machine, callback rejects non-InFlight | unit + sandbox |
| T8 | Retries cause double payment | Idempotent `agent:request_id` keys | unit + sandbox |
| T9 | Owner withdraws money promised to pending approvals | `withdraw` limited to available balance | unit |
| T10 | Vault runs out of storage/gas money | Fixed 0.5 NEAR operating reserve plus storage cost excluded from spendable balance | unit |
| T11 | Rejection spam fills storage | Rejections never become payment requests; only registered agents are logged, in a 50-entry ring buffer | unit |
| T12 | Approved recipient removed while a request is pending | `approve` re-checks the allowlist | unit |
| T13 | Token payment to a recipient not registered with the token contract | `storage_balance_of` check before `ft_transfer`; on failure the request ends `Failed` and budget and tokens are restored once | unit + sandbox |
| T14 | Fake token contract credits the vault to inflate balances | `ft_on_transfer` only credits tokens the owner added (by contract account); anything else is refunded | unit + sandbox |
| T15 | Token spending used to exceed NEAR budgets or the reverse | Separate shared cap and per-agent limits per asset | unit + sandbox |
| T16 | Odd token responses make a callback panic and strand a reservation | Callbacks read the raw promise result with a size bound and treat anything unexpected as failure | unit |

## Out of scope / known gaps
- Owner key compromise: the owner is fully trusted.
- Token contracts are trusted once the owner adds them: a malicious token could report a transfer it did not make. Only add tokens you trust, such as Circle's native USDC.
- Judgment about whether an allowlisted payment is sensible (limits only).
- Callback out-of-gas leaves a request InFlight; no recovery method yet (token payments have one more callback hop, with fixed gas for each).
- Metadata privacy: payments, memos and events are public on-chain.
