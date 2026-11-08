# Threat model

## Assets
- NEAR held by the vault contract.
- The policy: agent registry, limits, allowlist, pause state.
- In private mode: the vendor list and payment memos (confidentiality), and a TEE agent's key and prompts.
- The owner's intent for a job: a task's payees, budget, caps and trusted sources (origin-checked payments, see ORIGIN_CHECKS.md).

## Actors and authority

| Actor | Can | Cannot |
|---|---|---|
| Owner (`owner` account) | Change policy, approve/decline, withdraw unreserved funds, pause, remove agents, reconcile a stuck payment, hand ownership to an account that accepts it | Bypass reservation accounting, approve an expired request, reconcile a payment before its result could still arrive |
| Agent account | Call `request_payment` (with its function-call key) | Transfer NEAR, call other methods, approve its own requests |
| Vault contract | Send transfers it has reserved for | Act without a request or an owner approval |
| TEE agent (implicit account, key inside an Intel TDX VM) | `attest_agent` with a quote bound to its own account, then `request_payment` | Attest as another account, attest with an unapproved image |
| Proposed owner | `accept_ownership` | Anything else until accepted |
| Origin runtime: planner (privileged model) | Write a plan from the owner's request and the on-chain task | See any document text; use any operation besides `extract` and `pay` |
| Origin runtime: reader (quarantined model) | Return typed fields from one document | Call tools, change the plan, or remove the document's label from what it returns |
| Document sender (email, web page, file) | Put any text in front of the reader | Make its values owner-origin, or be trusted unless the owner lists its source on the task |
| Anyone | `deposit`, `expire_pending` (only releases approvals that are already overdue), view methods | Spend, read hidden vendors or sealed memos, initialize the contract |

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
| T8 | Retries cause double payment | Idempotent `agent:request_id` keys (kept for the last `history_limit` payments; see the storage section) | unit + sandbox |
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
| T27 | A callback runs out of gas and leaves a payment InFlight, with its budget reserved forever | `reconcile_stuck`: after 30 minutes the owner records the outcome (settle or release); a late callback is refused, so it still counts once | unit + sandbox |
| T28 | Approvals nobody decides on park an agent's budget indefinitely | Approvals expire (`approval_ttl_ms`, default 3 days); the next `request_payment` releases overdue ones, and anyone can call `expire_pending` | unit + sandbox |
| T29 | Ownership handed to a mistyped or uncontrolled account | Two-step transfer: `propose_owner`, then `accept_ownership` from the new account | unit + sandbox |
| T30 | Request records grow storage without bound and lock vault funds | History capped (`history_limit`, default 1,000) with old finished records deleted; at most 100 payments open at once | unit |
| T31 | Someone initializes a freshly deployed contract and becomes its owner | `new` is `#[private]`: only the vault account itself can call it | design (generated entry point) |
| T32 | A retired agent keeps limits, token limits or an attestation | `remove_agent` deletes them once nothing of the agent's is open | unit + sandbox |
| T33 | The deployed contract isn't the published source | Reproducible Docker build; CI fails if the committed wasm differs; `scripts/reproducible-build.sh --account` compares with the code hash on chain | CI |
| T34 | Invoice fraud: a forged email changes who to pay, to a vendor that is approved and under every limit | Under a task, the recipient must be owner-origin **and** one of the task's payees, checked by the contract (`recipient_from_untrusted_source`, `recipient_not_in_task`) | unit + runtime + sandbox + demo |
| T35 | Invoice fraud: a forged or lookalike email changes the amount | Amounts from a source the task doesn't trust are held for the owner with the source and the content's sha256 (`amount_from_untrusted_source`); trusted sources need a DKIM signature aligned with From | unit + runtime + sandbox + demo |
| T36 | A prompt injection fools the model that reads documents | The reader's output keeps its document's label whatever it says; it can't call tools or change the plan (CaMeL) | runtime + sandbox |
| T37 | A document's text reaches the planner and steers the plan | The planner's input is only the owner's request and the on-chain task; documents appear as ids; the plan language has two operations and is validated before it runs | runtime |
| T38 | Forged labels: an agent claims a document's value came from the owner | Labels are accepted only from an agent with a valid TDX attestation for an approved measurement, or one the owner vouches for; each payment records which (`label_trust`). Recipients are also checked against the task's payee list regardless of labels | unit + sandbox |
| T39 | An email edited in transit, or sent from a lookalike domain, passes as the vendor | DKIM must verify and its domain must match From; otherwise `email:unverified`, which the contract won't let an owner trust. A lookalike domain is labelled as itself | runtime |
| T40 | A task outlives its purpose or overspends | Per-task budget and per-payment cap (reservations count); end time; `close_task`; held payments can't be approved after the task closes; failed or declined payments return to the task budget | unit + sandbox |
| T41 | Injected text appears in the agent's report to the owner | The origin runtime writes its summary from the trace, not with a model | runtime |

## Out of scope / known gaps
- Payments that are made are public (amount, recipient, time); private mode does not hide them. No zero-knowledge proofs.
- TEE privacy trusts Intel TDX and dstack's key service. A break would expose a TEE agent's secrets but not bypass the vault's limits.
- An attestation is checked when submitted; between re-attestations the contract relies on the expiry.
- Owner key compromise: the owner is fully trusted.
- Token contracts are trusted once the owner adds them: a malicious token could report a transfer it did not make. Only add tokens you trust, such as Circle's native USDC.
- Judgment about whether an allowlisted payment is sensible (limits only).
- `reconcile_stuck` trusts the owner's reading of the explorer. Marking a token payment "not sent" when it was sent overcounts the vault's token balance; any payment or withdrawal that needs those missing tokens then fails at `ft_transfer` and is refunded, so nobody is overpaid, but the tracked balance stays too high and there is no method to correct it. Only mark a payment "not sent" after checking the explorer.
- A request id reused after its record has been pruned is treated as a new payment. Retries happen within seconds and pruning only after `history_limit` newer payments, so this needs an agent that reuses old ids on purpose; paid-API quote ids are unique.
- Metadata privacy: payments, memos and events are public on-chain.
- Origin labels are as trustworthy as the TEE and the runtime code (or, for owner-vouched agents, the owner's own server). The contract still confines every task payment to the task's payees, budget and caps even if labels were forged.
- The planner trusts the owner's request text. An owner who pastes an email into the request makes its text owner-origin; documents should be forwarded as documents.
- DKIM proves which domain sent a message, not that the domain is honest. Only list a source on a task if you trust its owner; a compromised vendor mailbox on a trusted domain can still set an amount, within the task's caps.

## Security review (Phase 4)

A pass over the finished contract before testnet and mainnet. Gas and storage
figures were measured on a local NEAR node (nearcore 2.14) with
`demo/scripts/measure.mjs`; the TEE figure with `demo/scripts/tee-gas.mjs`.

### Access control

| Method | Who may call | Check |
|---|---|---|
| `new` | the vault account itself, once | `#[init]` + `#[private]` (fixed in this phase: before, anyone could front-run the init of a fresh deploy) |
| `request_payment` | registered, active agents (others get `unknown_agent`) | policy checks before any state change; only registered agents are logged |
| `attest_agent` | registered agents | caller must match the quote's `report_data` |
| `on_payout`, `on_recipient_checked`, `on_token_withdraw` | the vault itself | `#[private]`, plus state checks (`InFlight` only) |
| `ft_on_transfer` | token contracts the owner added | anything else is refunded |
| `accept_ownership` | the proposed owner | exact match |
| `deposit`, `expire_pending` | anyone | can only add funds / release overdue approvals |
| `create_task`, `close_task`, `remove_task`, `set_label_vouch`, `set_origin_policy` | owner | `assert_owner()` (unit + sandbox tests) |
| every other state-changing method | owner | `assert_owner()` (checked method by method; covered by unit tests for the sensitive ones) |

The vault account's **full-access key** sits above all of this: whoever holds it
can deploy different code. See the upgrade policy below.

### Arithmetic

The release profile sets `overflow-checks = true`, so any overflow or underflow
aborts the transaction instead of wrapping. Amounts are bounded before they are
added: a request is compared with `per_tx_max` (which the owner sets at or
below `period_limit`) before it is added to spent and reserved, so sums stay
within owner-chosen values. Subtractions follow the reservation state machine
(each amount is added once on reserve and removed once on settle, fail,
decline or expiry), and the unit tests check `spent + reserved <= limit` after
every path. Timestamps and counters are `u64` milliseconds and sequence
numbers, far from overflow.

### Callback gas

| Step | Reserved | Measured |
|---|---|---|
| `request_payment`, native | caller attaches (clients use 150 Tgas) | 4.1 Tgas |
| `request_payment` with origin labels (task with 10 payees, 10 trusted sources) | | 4.8 Tgas |
| `create_task`, largest allowed | caller attaches | 3.2 Tgas |
| `request_payment`, 100 open payments, nothing due | | 3.4 Tgas |
| `request_payment` that expires 10 overdue approvals (worst case) | | 29.0 Tgas |
| `on_payout` (native) | 10 Tgas | 2.9 Tgas |
| `on_recipient_checked` | 40 Tgas (includes `ft_transfer` 15 and `on_payout` 10) | 2.9 Tgas |
| `on_payout` (token) | 10 Tgas | 3.1 Tgas |
| `expire_pending` releasing 90 approvals | caller attaches | 58.6 Tgas |
| `attest_agent` (Intel TDX verification) | caller attaches 300 Tgas | about 189 Tgas |

Every callback has at least 3x headroom. If one still failed, the payment
stays `InFlight` and `reconcile_stuck` recovers it (T27). On-chain TDX
verification uses dcap-qvl's `ring` backend: the pure-Rust backend was tried
for the reproducible build and exceeded the 300 Tgas transaction limit.

### Storage

The vault pays for its own storage, and the spendable balance always excludes
the current storage cost and a 0.5 NEAR operating reserve, so agents can never
spend the money that keeps the contract alive.

- Code: the 766 KB wasm locks about 7.7 NEAR.
- A payment record: 358 bytes with no memo (0.0036 NEAR), 463 bytes with origin
  labels, 1,038 bytes with the largest encrypted memo (0.0104 NEAR).
- A task: up to 1,104 bytes (0.011 NEAR) at the largest allowed size; at most
  100 tasks are stored, and closed ones can be removed to free the deposit.
- History is capped: with the default `history_limit` of 1,000, records lock at
  most about 10 NEAR, and deleting old ones returns that deposit. The owner can
  set 100 to 10,000.
- At most 100 payments can be open (pending or in flight) at once, which bounds
  the expiry sweep and the budget an agent can park.
- The blocked-attempt log is a 50-entry ring buffer.

Finding: tiny payments are bounded by amount limits only in total, not in
number, so an agent (or someone with its key) could fill the history with
1-yoctoNEAR payments and lock up to the history cap's worth of storage. It
pays its own gas to do so, nothing is stolen, and the deposit comes back as
records are pruned. **Mitigation for mainnet:** set a payments-per-hour limit
(for example 30) and keep the history limit at or below 1,000.

### Upgrade policy

The contract has no upgrade or migrate method. Code changes only by deploying
with the vault account's full-access key, so that key is the real master key.

- **Recommended for mainnet:** deploy and initialize, verify the code hash
  with `scripts/reproducible-build.sh --account <vault>`, then delete the vault
  account's full-access keys. The contract is then immutable and anyone can
  check it runs exactly this source. A new version means a new vault: the
  owner withdraws from the old one and funds the new one.
- If you keep an upgrade path, keep the vault's full-access key on a hardware
  wallet, never on the machine that runs agents, and plan a state migration:
  the state layout changed in this phase (new fields), so deploying new code
  over an old vault without a migration fails to load state.

### Reproducible build

`scripts/reproducible-build.sh` builds the wasm in a Docker image pinned by
digest (NEAR's `sourcescan/cargo-near` image with Rust 1.97.1 and clang 19),
with `Cargo.lock`, a pinned wasm-opt (binaryen 132, checksum-verified) and
fixed, remapped paths. Two clean builds produce the same bytes. CI rebuilds on
every pull request and fails if `contract/res/banbo.wasm` differs; the sha256 is
in `contract/res/banbo.wasm.sha256`. NEAR's code hash is base58 of that sha256.

### Residual risks

- The owner is fully trusted, and so is whoever holds the vault account's
  full-access key (until it is deleted).
- Token contracts are trusted once added.
- Not externally audited, and deployed on testnet only. Don't put real funds in it.
