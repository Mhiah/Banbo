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
| T11 | Rejection spam fills storage | Rejections write no storage, only a log event | unit |
| T12 | Approved recipient removed while a request is pending | `approve` re-checks the allowlist | unit |

## Out of scope / known gaps
- Owner key compromise: the owner is fully trusted.
- Judgment about whether an allowlisted payment is sensible (limits only).
- Callback out-of-gas leaves a request InFlight; no recovery method yet.
- Metadata privacy: payments, memos and events are public on-chain.
