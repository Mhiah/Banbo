# Threat model

## Assets
- NEAR held by the vault contract.
- The policy: agent registry, limits, allowlist, pause state.
- In private mode: the vendor list and payment memos (confidentiality), and a TEE agent's key and prompts.

## Actors and authority

| Actor | Can | Cannot |
|---|---|---|
| Owner (`owner` account) | Change policy, approve/decline, withdraw unreserved funds, pause | Bypass reservation accounting |
| Agent account | Call `request_payment` (with its function-call key) | Transfer NEAR, call other methods, approve its own requests |
| Vault contract | Send transfers it has reserved for | Act without a request or an owner approval |
| TEE agent (implicit account, key inside an Intel TDX VM) | `attest_agent` with a quote bound to its own account, then `request_payment` | Attest as another account, attest with an unapproved image |
| Anyone | `deposit`, view methods | Spend, read hidden vendors or sealed memos |

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
| T17 | Owner is tricked into allowing an attacker's account, which is then paid at once | New recipient cooldown (`recipient_in_cooldown`) gives time to notice and remove it | unit + sandbox + demo |
| T18 | Slow drip: many small payments that each pass every amount limit | Per-agent payments-per-hour limit (`exceeds_payment_rate`) | unit + sandbox + demo |
| T19 | Observer reads the vendor list from contract state | Hidden allowlist stores only salted sha256 fingerprints (32-byte random salt); labels are sealed to the owner | unit + sandbox |
| T20 | Injection gets the agent to reuse a hidden vendor's salt for the attacker | Fingerprint covers the account name; the salt never reaches the model (runtime config) | unit + sandbox + demo |
| T21 | Memos leak business details on a public chain | Memos sealed to the owner's X25519 key by the runtime; `encrypted_memos_only` refuses plaintext and doesn't store it | unit + sandbox + demo |
| T22 | Tampered hidden-vendor label shows the owner a wrong name | Dashboard recomputes the fingerprint from the opened label and refuses a mismatch | dashboard unit |
| T23 | Agent claims to run in a TEE but doesn't, or runs other code | Intel DCAP verification on-chain, TCB status, RTMR3 replay, MRTD/RTMR0-2 + compose hash matched against owner-approved images | unit (synthetic + genuine Intel quote) + sandbox |
| T24 | Someone replays a genuine quote from another VM | `report_data` must equal the caller's implicit account; only accounts the owner added can attest | unit + sandbox |
| T25 | An approved image turns out to be bad, or a host is suspect | `remove_tee_measurement` cuts off every agent on that image at once; `revoke_attestation`; attestations expire | unit |
| T26 | Confidential payouts let an agent pay an unverified recipient | Not used for agent payouts: the contract can't verify a confidential payment's final recipient (see PRIVACY.md) | design |

## Out of scope / known gaps
- Payments that are made are public (amount, recipient, time); private mode does not hide them. No zero-knowledge proofs.
- TEE privacy trusts Intel TDX and dstack's key service. A break would expose a TEE agent's secrets but not bypass the vault's limits.
- An attestation is checked when submitted; between re-attestations the contract relies on the expiry.
- Owner key compromise: the owner is fully trusted.
- Token contracts are trusted once the owner adds them: a malicious token could report a transfer it did not make. Only add tokens you trust, such as Circle's native USDC.
- Judgment about whether an allowlisted payment is sensible (limits only).
- Callback out-of-gas leaves a request InFlight; no recovery method yet (token payments have one more callback hop, with fixed gas for each).
- Metadata privacy: payments, memos and events are public on-chain.
