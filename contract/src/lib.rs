//! Banbo: a NEAR vault that lets AI agents spend from a shared treasury
//! without ever holding the treasury's keys.
//!
//! Every payment goes through `request_payment`, which checks the policy
//! (registered agent, allowlisted recipient, per-request max, per-agent and
//! shared period budgets, vault balance) and *reserves* the amount before the
//! transfer is sent. NEAR transfers are asynchronous: the transfer runs in a
//! later receipt and its outcome comes back in `on_payout`. A failed transfer
//! releases the reservation exactly once; a successful one moves it to spent.
//!
//! Payments can be in native NEAR or in a NEP-141 token such as USDC. Each
//! token has its own shared cap and its own per-agent limits; a token payment
//! first checks that the recipient is registered with the token contract,
//! then sends `ft_transfer`, and reconciles in the same `on_payout` callback.
//!
//! Private mode adds three things: a hidden allowlist (recipients stored only
//! as salted fingerprints), memos encrypted to the owner's key, and agents
//! that must prove with an Intel TDX attestation that they run approved code
//! inside a TEE (see `tee.rs`). Amounts and recipients of payments that are
//! actually made stay public, as on any public chain.
//!
//! Origin-checked payments (see docs/ORIGIN_CHECKS.md) apply the CaMeL
//! design from "Defeating Prompt Injections by Design" (Debenedetti et al.,
//! Google, Google DeepMind and ETH Zurich, 2025) on-chain. The owner opens a
//! task with its payees, budget and trusted sources. An attested agent
//! runtime labels where each payment's recipient and amount came from, and
//! the contract pays only when the recipient was set by the owner and the
//! amount came from the owner or a source the owner trusts for that task.
//! Anything else is refused or held for the owner, with its source.
//!
//! Core invariant, per agent and for the shared treasury, per asset, in the
//! current period:
//!     spent + reserved <= limit
//! and every request id settles at most once.

mod tee;
pub use tee::{TeeAttestation, TeeCollateral, TeeEvent, TeeInfo, TeeMeasurement, TeeTcbInfo};

use near_sdk::json_types::U128;
use sha2::{Digest, Sha256};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseOrValue,
};

/// Gas reserved for the payout callback.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Gas for the token contract's `storage_balance_of` view.
const FT_CHECK_GAS: Gas = Gas::from_tgas(5);
/// Gas for the token contract's `ft_transfer`.
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
/// Gas for `on_recipient_checked`, which itself schedules ft_transfer + on_payout.
const RECIPIENT_CHECK_GAS: Gas = Gas::from_tgas(40);
/// Longest promise result we read from a token contract.
const MAX_RESULT_LEN: usize = 512;
const MAX_SYMBOL_LEN: usize = 12;
/// Window for the per-agent payment rate limit.
const RATE_WINDOW_MS: u64 = 3_600_000;
/// Balance always kept back for storage and gas, never spendable by agents.
const OPERATING_RESERVE: NearToken = NearToken::from_millinear(500);
const MAX_MEMO_LEN: usize = 256;
/// Encrypted memos and labels: "enc1:" + base64 of a sealed box.
const MAX_ENC_LEN: usize = 512;
const ENC_PREFIX: &str = "enc1:";
const KEY_PREFIX: &str = "x25519:";
/// Default lifetime of an agent's TEE attestation.
const DEFAULT_ATTESTATION_TTL_MS: u64 = 7 * 24 * 3_600_000;
/// Pending approvals expire after this long by default.
const DEFAULT_APPROVAL_TTL_MS: u64 = 3 * 24 * 3_600_000;
const MIN_APPROVAL_TTL_MS: u64 = 60_000;
const MAX_APPROVAL_TTL_MS: u64 = 30 * 24 * 3_600_000;
/// Payments waiting for approval or for their transfer result, at most.
/// Bounds the work an expiry sweep can do and the budget an agent can park.
const MAX_OPEN: u32 = 100;
/// Expired approvals released per sweep.
const SWEEP_LIMIT: u32 = 10;
/// A transfer's result normally arrives within a few blocks. After this long
/// without one, the owner may reconcile the payment by hand.
const IN_FLIGHT_RECOVERY_MS: u64 = 30 * 60_000;
/// Payment records kept by default; older finished ones are deleted, which
/// returns their storage deposit to the vault.
const DEFAULT_HISTORY_LIMIT: u32 = 1_000;
const MIN_HISTORY_LIMIT: u32 = 100;
const MAX_HISTORY_LIMIT: u32 = 10_000;
/// Old records deleted per new payment, so a lowered limit catches up.
const PRUNE_PER_INSERT: u32 = 3;
const MAX_REQUEST_ID_LEN: usize = 64;
/// Blocked attempts kept on-chain for the dashboard (oldest overwritten).
const BLOCKED_LOG_SIZE: u32 = 50;
const BLOCKED_MEMO_LEN: usize = 80;
/// Most tasks stored at once (open or closed); closed ones can be removed.
const MAX_TASKS: u32 = 100;
const MAX_TASK_ID_LEN: usize = 64;
const MAX_TASK_PAYEES: usize = 10;
const MAX_TASK_SOURCES: usize = 10;
const MAX_SOURCE_LEN: usize = 100;
const MAX_TASK_DESCRIPTION_LEN: usize = 256;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    Allowlist,
    Requests,
    Blocked,
    Tokens,
    TokenLimits,
    RecipientAddedAt,
    Rate,
    Hidden,
    TeeMeasurements,
    TeePpids,
    Tee,
    History,
    Open,
    Tasks,
    Vouched,
}

/// A hidden allowlist entry. Only the fingerprint
/// sha256("banbo-recipient-v1:" + account + ":" + salt) is stored, where the
/// salt is 32 random bytes the owner gives the agent. Nobody can tell which
/// account it stands for until the agent pays it (the payment itself is
/// public). `label` is an optional note encrypted to the owner's key.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HiddenRecipient {
    pub added_at_ms: u64,
    /// Cooldown in force when it was added.
    pub cooldown_ms: u64,
    pub label: Option<String>,
}

#[near(serializers = [json])]
pub struct HiddenRecipientView {
    pub fingerprint: String,
    pub added_at_ms: u64,
    pub payable_from_ms: u64,
    pub label: Option<String>,
}

#[near(serializers = [json])]
pub struct TeePolicy {
    /// When on, only agents with a valid attestation can be paid out for.
    pub require_tee: bool,
    pub attestation_ttl_ms: u64,
    /// Accept a TCB status of SWHardeningNeeded as well as UpToDate.
    pub allow_sw_hardening_needed: bool,
    pub measurements: Vec<(String, TeeMeasurement)>,
    /// Empty = any CPU.
    pub ppids: Vec<String>,
}

/// How many payments an agent made in the current one-hour window.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RateWindow {
    pub window_start_ms: u64,
    pub count: u32,
}

/// An allowed recipient and when it can first be paid.
#[near(serializers = [json])]
pub struct Recipient {
    pub account: AccountId,
    pub added_at_ms: u64,
    /// added_at_ms + the cooldown it was added under (or the current one, if lower).
    pub payable_from_ms: u64,
}

/// The NEP-141 methods Banbo calls.
#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_balance_of(&self, account_id: AccountId) -> Option<near_sdk::serde_json::Value>;
}

/// An agent's limits and counters for one asset.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    pub per_tx_max: U128,
    pub period_limit: U128,
    pub approval_threshold: U128,
    pub period_index: u64,
    pub spent: U128,
    pub reserved: U128,
}

/// A NEP-141 token the vault holds and agents may spend. Amounts are in the
/// token's smallest unit.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub symbol: String,
    pub decimals: u8,
    /// Tokens the vault holds, minus transfers in flight.
    pub balance: U128,
    pub shared_cap: U128,
    pub shared_period: u64,
    pub shared_spent: U128,
    pub shared_reserved: U128,
    pub pending: U128,
    pub in_flight: U128,
}

#[near(serializers = [json])]
pub struct TokenView {
    pub token: AccountId,
    pub symbol: String,
    pub decimals: u8,
    pub balance: U128,
    pub pending_approval: U128,
    pub in_flight: U128,
    pub available: U128,
    pub shared_cap: U128,
    pub shared_spent: U128,
    pub shared_reserved: U128,
}

/// Shared budget counters for one asset.
struct Pool {
    cap: u128,
    period: u64,
    spent: u128,
    reserved: u128,
    pending: u128,
    in_flight: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    /// Largest single payment this agent may request.
    pub per_tx_max: U128,
    /// Total this agent may spend (spent + reserved) per period.
    pub period_limit: U128,
    /// Payments above this amount wait for the owner's approval.
    pub approval_threshold: U128,
    pub active: bool,
    pub period_index: u64,
    pub spent: U128,
    pub reserved: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    /// Over the approval threshold; budget is held until the owner decides.
    PendingApproval,
    /// Transfer sent; waiting for its result.
    InFlight,
    Settled,
    /// Transfer failed; reservation released.
    Failed,
    /// Owner declined a pending request; reservation released.
    Declined,
    /// Nobody approved it in time; reservation released.
    Expired,
}

impl Status {
    fn is_final(&self) -> bool {
        !matches!(self, Status::PendingApproval | Status::InFlight)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PaymentRequest {
    pub key: String,
    pub agent: AccountId,
    pub request_id: String,
    pub recipient: AccountId,
    pub amount: U128,
    /// NEP-141 token contract, or None for native NEAR.
    pub token: Option<AccountId>,
    pub memo: String,
    /// Set when the recipient was matched on the hidden allowlist.
    pub recipient_fingerprint: Option<String>,
    pub status: Status,
    /// Why a Failed payment failed: transfer_failed or recipient_not_registered.
    pub failure_reason: Option<String>,
    pub period_index: u64,
    pub created_at_ms: u64,
    /// When the transfer was sent.
    pub dispatched_at_ms: Option<u64>,
    /// Pending approvals only: the owner must decide before this time.
    pub expires_at_ms: Option<u64>,
    /// Position in the payment history.
    pub seq: u64,
    /// Origin labels, for payments made under a task.
    pub origin: Option<PaymentOrigin>,
    /// Why a payment waits for the owner: over_approval_threshold or
    /// amount_from_untrusted_source.
    pub hold_reason: Option<String>,
    /// Why the labels were believed: "tee" (valid attestation) or
    /// "owner_vouched".
    pub label_trust: Option<String>,
}

/// A rejected payment attempt, kept in a fixed-size ring buffer so the owner
/// can see attacks without an indexer. Bounded, so rejection spam can't grow
/// storage.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BlockedAttempt {
    pub agent: AccountId,
    pub request_id: String,
    pub recipient: AccountId,
    pub amount: U128,
    pub token: Option<AccountId>,
    pub reason: String,
    /// Truncated to 80 bytes (encrypted memos are kept whole).
    pub memo: String,
    pub at_ms: u64,
    /// The origin labels the agent sent, so the owner sees which source tried it.
    pub origin: Option<PaymentOrigin>,
}

/// Where a value in a payment request came from, as labelled by the agent's
/// attested runtime (the CaMeL "capability" of the value).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Origin {
    /// Taken from the owner's own instructions or from the task itself.
    Owner,
    /// Extracted from untrusted content. `source` names it, e.g.
    /// "email:acme.com" (domain of a DKIM-verified sender) or "web:acme.com";
    /// `digest` is the sha256 (hex) of the content, so the owner can match
    /// the exact message.
    Source { source: String, digest: String },
}

/// The origin labels an attested agent sends with a payment.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PaymentOrigin {
    pub task_id: String,
    pub recipient: Origin,
    pub amount: Origin,
}

/// A job the owner gives an agent: who may be paid, how much in total and
/// per payment, until when, and which untrusted sources may set an amount.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Task {
    pub id: String,
    pub agent: AccountId,
    pub description: String,
    /// The only recipients this task can pay. Set by the owner, so they are
    /// owner-origin by construction.
    pub payees: Vec<AccountId>,
    /// NEP-141 token, or None for native NEAR.
    pub token: Option<AccountId>,
    pub budget: U128,
    pub max_per_payment: U128,
    /// Sources allowed to set an amount without the owner's review, e.g.
    /// "email:acme.com". Recipients can never come from a source.
    pub trusted_sources: Vec<String>,
    pub spent: U128,
    pub reserved: U128,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub closed: bool,
}

/// What `request_payment` tells the agent. Rejections are returned (and logged
/// as events) instead of panicking so an agent gets a clear, machine-readable
/// reason. Only registered agents' rejections are recorded, in a bounded log.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum RequestOutcome {
    Dispatched { key: String },
    PendingApproval { key: String },
    Rejected { reason: String },
    /// Same agent + request id was seen before; nothing new happened.
    Duplicate { key: String, status: Status },
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub paused: bool,
    pub period_ms: u64,
    pub shared_cap: U128,
    pub current_period: u64,
    /// A newly allowed recipient can't be paid for this long (0 = off).
    pub recipient_cooldown_ms: u64,
    /// Most payment requests one agent may make per hour (0 = no limit).
    pub max_payments_per_hour: u32,
    /// "x25519:<hex>": agents encrypt memos to this key.
    pub owner_encryption_key: Option<String>,
    /// Plaintext memos are rejected.
    pub encrypted_memos_only: bool,
    pub require_tee: bool,
    /// Proposed new owner, until they accept.
    pub pending_owner: Option<AccountId>,
    pub approval_ttl_ms: u64,
    pub history_limit: u32,
    /// How long a payment must be in flight before the owner may reconcile it.
    pub in_flight_recovery_ms: u64,
    pub open_payments: u32,
    /// Every payment must carry origin labels from an attested agent.
    pub require_origin: bool,
}

#[near(serializers = [json])]
pub struct Balances {
    pub vault_balance: U128,
    pub operating_reserve: U128,
    pub storage_cost: U128,
    pub pending_approval: U128,
    pub in_flight: U128,
    pub available: U128,
    pub shared_spent: U128,
    pub shared_reserved: U128,
    pub shared_cap: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Banbo {
    owner: AccountId,
    paused: bool,
    period_ms: u64,
    shared_cap: u128,
    shared_period: u64,
    shared_spent: u128,
    shared_reserved: u128,
    /// Sum of amounts in PendingApproval (still in the vault balance).
    pending_total: u128,
    /// Sum of amounts InFlight (already deducted from the vault balance).
    in_flight_total: u128,
    pending_owner: Option<AccountId>,
    agents: IterableMap<AccountId, Agent>,
    allowlist: IterableSet<AccountId>,
    requests: LookupMap<String, PaymentRequest>,
    /// Payment keys in creation order, from history_head to history_tail.
    history: LookupMap<u64, String>,
    history_head: u64,
    history_tail: u64,
    history_limit: u32,
    /// Keys of payments that are PendingApproval or InFlight.
    open: IterableSet<String>,
    approval_ttl_ms: u64,
    /// Earliest expiry among pending approvals (u64::MAX if none), so the
    /// sweep costs nothing until something can actually expire.
    next_expiry_ms: u64,
    blocked: Vector<BlockedAttempt>,
    blocked_total: u64,
    tokens: IterableMap<AccountId, Token>,
    /// Keyed by "agent|token".
    token_limits: LookupMap<String, Limits>,
    recipient_cooldown_ms: u64,
    max_payments_per_hour: u32,
    /// recipient -> (added at, cooldown in force when it was added)
    recipient_added_at: LookupMap<AccountId, (u64, u64)>,
    rate: LookupMap<AccountId, RateWindow>,
    /// fingerprint -> entry
    hidden: IterableMap<String, HiddenRecipient>,
    owner_encryption_key: Option<String>,
    encrypted_memos_only: bool,
    require_tee: bool,
    attestation_ttl_ms: u64,
    allow_sw_hardening_needed: bool,
    tee_measurements: IterableMap<String, TeeMeasurement>,
    tee_ppids: IterableSet<String>,
    tee: LookupMap<AccountId, TeeInfo>,
    tasks: IterableMap<String, Task>,
    /// Agents whose origin labels the owner vouches for without a TEE
    /// attestation (e.g. a runtime on the owner's own server, or a local
    /// demo). Weaker than attestation, and recorded as such on each payment.
    vouched: IterableSet<AccountId>,
    /// When on, every payment must come from an attested agent, under a task,
    /// with origin labels.
    require_origin: bool,
}

/// sha256("banbo-recipient-v1:" + account + ":" + salt), hex. The salt is
/// 32 bytes as 64 lowercase hex characters.
pub fn recipient_fingerprint(recipient: &AccountId, salt: &str) -> Option<String> {
    if salt.len() != 64 || !salt.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return None;
    }
    let pre = format!("banbo-recipient-v1:{}:{}", recipient, salt);
    Some(hex::encode(Sha256::digest(pre.as_bytes())))
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// "enc1:" followed by base64 only.
fn is_encrypted(s: &str) -> bool {
    s.len() > ENC_PREFIX.len()
        && s.len() <= MAX_ENC_LEN
        && s.starts_with(ENC_PREFIX)
        && s[ENC_PREFIX.len()..]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/' || c == b'=' || c == b'-' || c == b'_')
}

fn event(kind: &str, data: String) {
    log!(
        "EVENT_JSON:{{\"standard\":\"banbo\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        kind,
        data
    );
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

fn esc(s: &str) -> String {
    near_sdk::serde_json::to_string(s).unwrap()
}

fn esc_token(t: &Option<AccountId>) -> String {
    t.as_ref().map(|t| esc(t.as_str())).unwrap_or_else(|| "null".into())
}

/// "kind:name" with kind email|web|doc|api and a short printable name.
fn valid_source(s: &str) -> bool {
    let Some((kind, name)) = s.split_once(':') else { return false };
    matches!(kind, "email" | "web" | "doc" | "api")
        && !name.is_empty()
        && s.len() <= MAX_SOURCE_LEN
        && name.bytes().all(|b| b.is_ascii_graphic())
}

fn valid_origin(o: &Origin) -> bool {
    match o {
        Origin::Owner => true,
        Origin::Source { source, digest } => {
            valid_source(source)
                && digest.len() == 64
                && digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }
    }
}

fn origin_json(o: &Option<PaymentOrigin>) -> String {
    o.as_ref().map(|o| near_sdk::serde_json::to_string(o).unwrap()).unwrap_or_else(|| "null".into())
}

fn limits_key(agent: &AccountId, token: &AccountId) -> String {
    format!("{}|{}", agent, token)
}

#[near]
impl Banbo {
    /// Only the vault account itself, or the account directly above it
    /// (the one that created it, e.g. the Banbo factory for
    /// `name.factory.near`), can initialize it, so nobody can front-run a
    /// deploy and make themselves the owner.
    #[init]
    pub fn new(owner: AccountId, period_ms: u64, shared_cap: U128) -> Self {
        let me = env::current_account_id();
        let caller = env::predecessor_account_id();
        require!(
            caller == me || me.as_str().strip_suffix(caller.as_str()).is_some_and(|name| name.ends_with('.') && !name[..name.len() - 1].contains('.')),
            "only the vault account or the account that created it can initialize it"
        );
        require!(period_ms > 0, "period_ms must be > 0");
        Self {
            owner,
            paused: false,
            period_ms,
            shared_cap: shared_cap.0,
            shared_period: 0,
            shared_spent: 0,
            shared_reserved: 0,
            pending_total: 0,
            in_flight_total: 0,
            pending_owner: None,
            agents: IterableMap::new(StorageKey::Agents),
            allowlist: IterableSet::new(StorageKey::Allowlist),
            requests: LookupMap::new(StorageKey::Requests),
            history: LookupMap::new(StorageKey::History),
            history_head: 0,
            history_tail: 0,
            history_limit: DEFAULT_HISTORY_LIMIT,
            open: IterableSet::new(StorageKey::Open),
            approval_ttl_ms: DEFAULT_APPROVAL_TTL_MS,
            next_expiry_ms: u64::MAX,
            blocked: Vector::new(StorageKey::Blocked),
            blocked_total: 0,
            tokens: IterableMap::new(StorageKey::Tokens),
            token_limits: LookupMap::new(StorageKey::TokenLimits),
            recipient_cooldown_ms: 0,
            max_payments_per_hour: 0,
            recipient_added_at: LookupMap::new(StorageKey::RecipientAddedAt),
            rate: LookupMap::new(StorageKey::Rate),
            hidden: IterableMap::new(StorageKey::Hidden),
            owner_encryption_key: None,
            encrypted_memos_only: false,
            require_tee: false,
            attestation_ttl_ms: DEFAULT_ATTESTATION_TTL_MS,
            allow_sw_hardening_needed: false,
            tee_measurements: IterableMap::new(StorageKey::TeeMeasurements),
            tee_ppids: IterableSet::new(StorageKey::TeePpids),
            tee: LookupMap::new(StorageKey::Tee),
            tasks: IterableMap::new(StorageKey::Tasks),
            vouched: IterableSet::new(StorageKey::Vouched),
            require_origin: false,
        }
    }

    // ---------------------------------------------------------------- funding

    /// Anyone can top up the vault.
    #[payable]
    pub fn deposit(&mut self) {
        let amount = env::attached_deposit();
        event(
            "deposit",
            format!(
                "{{\"from\":{},\"amount\":\"{}\"}}",
                esc(env::predecessor_account_id().as_str()),
                amount.as_yoctonear()
            ),
        );
    }

    /// Owner withdraws funds that are not reserved or needed for operation.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 <= self.available(&None), "amount exceeds available balance");
        event("withdraw", format!("{{\"amount\":\"{}\"}}", amount.0));
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// NEP-141 receiver: tokens sent to the vault with `ft_transfer_call`.
    /// Only tokens the owner added are kept; anything else is refunded.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        let token_id = env::predecessor_account_id();
        let Some(t) = self.tokens.get_mut(&token_id) else {
            return PromiseOrValue::Value(amount);
        };
        t.balance = U128(t.balance.0 + amount.0);
        event(
            "token_deposit",
            format!(
                "{{\"token\":{},\"from\":{},\"amount\":\"{}\"}}",
                esc(token_id.as_str()),
                esc(sender_id.as_str()),
                amount.0
            ),
        );
        PromiseOrValue::Value(U128(0))
    }

    /// Owner withdraws tokens that are not reserved. Restored if the transfer fails.
    pub fn withdraw_token(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(self.tokens.contains_key(&token), "unknown token");
        require!(amount.0 > 0 && amount.0 <= self.available(&Some(token.clone())), "amount exceeds available balance");
        let t = self.tokens.get_mut(&token).unwrap();
        t.balance = U128(t.balance.0 - amount.0);
        event("token_withdraw", format!("{{\"token\":{},\"amount\":\"{}\"}}", esc(token.as_str()), amount.0));
        ext_ft::ext(token.clone())
            .with_static_gas(FT_TRANSFER_GAS)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .ft_transfer(self.owner.clone(), amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_token_withdraw(token, amount),
            )
    }

    #[private]
    pub fn on_token_withdraw(&mut self, token: AccountId, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, MAX_RESULT_LEN).is_ok();
        if !ok {
            if let Some(t) = self.tokens.get_mut(&token) {
                t.balance = U128(t.balance.0 + amount.0);
            }
            event("token_withdraw_failed", format!("{{\"token\":{},\"amount\":\"{}\"}}", esc(token.as_str()), amount.0));
        }
        ok
    }

    // ----------------------------------------------------------- owner policy

    pub fn add_agent(
        &mut self,
        agent: AccountId,
        per_tx_max: U128,
        period_limit: U128,
        approval_threshold: U128,
    ) {
        self.assert_owner();
        require!(per_tx_max.0 <= period_limit.0, "per_tx_max must be <= period_limit");
        let period = self.current_period();
        let existing = self.agents.get(&agent).cloned();
        let (spent, reserved, period_index) = match existing {
            Some(a) => (a.spent, a.reserved, a.period_index),
            None => (U128(0), U128(0), period),
        };
        self.agents.insert(
            agent.clone(),
            Agent {
                per_tx_max,
                period_limit,
                approval_threshold,
                active: true,
                period_index,
                spent,
                reserved,
            },
        );
        event(
            "agent_set",
            format!(
                "{{\"agent\":{},\"per_tx_max\":\"{}\",\"period_limit\":\"{}\",\"approval_threshold\":\"{}\"}}",
                esc(agent.as_str()),
                per_tx_max.0,
                period_limit.0,
                approval_threshold.0
            ),
        );
    }

    /// Instantly cut an agent off. In-flight payments still reconcile.
    pub fn set_agent_active(&mut self, agent: AccountId, active: bool) {
        self.assert_owner();
        let a = self.agents.get_mut(&agent).unwrap_or_else(|| env::panic_str("unknown agent"));
        a.active = active;
        event(
            "agent_active",
            format!("{{\"agent\":{},\"active\":{}}}", esc(agent.as_str()), active),
        );
    }

    /// Remove an agent for good: its limits, token limits, rate window and
    /// attestation are deleted (freeing their storage). Only possible when
    /// it has nothing pending or in flight; decline or wait for those first.
    /// To stop an agent right away, use `set_agent_active(false)`.
    pub fn remove_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        let a = self.agents.get(&agent).cloned().unwrap_or_else(|| env::panic_str("unknown agent"));
        require!(a.reserved.0 == 0, "agent has payments pending or in flight");
        let tokens: Vec<AccountId> = self.tokens.keys().cloned().collect();
        for t in &tokens {
            let k = limits_key(&agent, t);
            if let Some(l) = self.token_limits.get(&k) {
                require!(l.reserved.0 == 0, "agent has payments pending or in flight");
            }
        }
        for t in &tokens {
            self.token_limits.remove(&limits_key(&agent, t));
        }
        self.agents.remove(&agent);
        self.rate.remove(&agent);
        self.tee.remove(&agent);
        self.vouched.remove(&agent);
        event("agent_removed", format!("{{\"agent\":{}}}", esc(agent.as_str())));
    }

    /// Step one of an ownership transfer: name the new owner (None cancels).
    /// Nothing changes until they call `accept_ownership`, so a typo can't
    /// hand the vault to an account nobody controls.
    pub fn propose_owner(&mut self, new_owner: Option<AccountId>) {
        self.assert_owner();
        if let Some(n) = &new_owner {
            require!(n != &self.owner, "already the owner");
        }
        self.pending_owner = new_owner.clone();
        event(
            "owner_proposed",
            format!(
                "{{\"owner\":{},\"proposed\":{}}}",
                esc(self.owner.as_str()),
                new_owner.as_ref().map(|n| esc(n.as_str())).unwrap_or_else(|| "null".into())
            ),
        );
    }

    /// Step two: the proposed owner accepts.
    pub fn accept_ownership(&mut self) {
        let caller = env::predecessor_account_id();
        require!(self.pending_owner.as_ref() == Some(&caller), "not the proposed owner");
        let previous = std::mem::replace(&mut self.owner, caller.clone());
        self.pending_owner = None;
        event(
            "owner_changed",
            format!("{{\"previous\":{},\"owner\":{}}}", esc(previous.as_str()), esc(caller.as_str())),
        );
    }

    /// How long a payment waits for approval before it expires and its budget
    /// is released. Applies to payments requested from now on.
    pub fn set_approval_ttl(&mut self, approval_ttl_ms: u64) {
        self.assert_owner();
        require!(
            (MIN_APPROVAL_TTL_MS..=MAX_APPROVAL_TTL_MS).contains(&approval_ttl_ms),
            "approval_ttl_ms must be between 1 minute and 30 days"
        );
        self.approval_ttl_ms = approval_ttl_ms;
        event("approval_ttl_set", format!("{{\"approval_ttl_ms\":{}}}", approval_ttl_ms));
    }

    /// How many payment records to keep. Older finished records are deleted
    /// a few at a time as new payments come in, returning their storage
    /// deposit to the vault.
    pub fn set_history_limit(&mut self, history_limit: u32) {
        self.assert_owner();
        require!(
            (MIN_HISTORY_LIMIT..=MAX_HISTORY_LIMIT).contains(&history_limit),
            "history_limit must be between 100 and 10000"
        );
        self.history_limit = history_limit;
        event("history_limit_set", format!("{{\"history_limit\":{}}}", history_limit));
    }

    /// Allow a recipient. With a cooldown set, it can't be paid until the
    /// cooldown has passed, which gives the owner time to notice a recipient
    /// that was added by mistake or by someone who tricked them.
    pub fn allow_recipient(&mut self, recipient: AccountId) {
        self.assert_owner();
        if self.allowlist.insert(recipient.clone()) {
            self.recipient_added_at.insert(recipient.clone(), (env::block_timestamp_ms(), self.recipient_cooldown_ms));
        }
        event(
            "recipient_allowed",
            format!(
                "{{\"recipient\":{},\"payable_from_ms\":{}}}",
                esc(recipient.as_str()),
                self.payable_from(&recipient)
            ),
        );
    }

    pub fn disallow_recipient(&mut self, recipient: AccountId) {
        self.assert_owner();
        self.allowlist.remove(&recipient);
        self.recipient_added_at.remove(&recipient);
        event("recipient_removed", format!("{{\"recipient\":{}}}", esc(recipient.as_str())));
    }

    /// Recipient risk rules. `recipient_cooldown_ms`: how long a recipient
    /// allowed from now on must wait before it can be paid (0 = off).
    /// Recipients already allowed keep the cooldown they were added under,
    /// and lowering the cooldown shortens it for everyone.
    /// `max_payments_per_hour`: payment requests per agent per hour (0 = no
    /// limit); stops slow-drip theft that stays under the amount limits.
    pub fn set_risk_rules(&mut self, recipient_cooldown_ms: u64, max_payments_per_hour: u32) {
        self.assert_owner();
        self.recipient_cooldown_ms = recipient_cooldown_ms;
        self.max_payments_per_hour = max_payments_per_hour;
        event(
            "risk_rules_set",
            format!(
                "{{\"recipient_cooldown_ms\":{},\"max_payments_per_hour\":{}}}",
                recipient_cooldown_ms, max_payments_per_hour
            ),
        );
    }

    // ----------------------------------------------------------- private mode

    /// Add a hidden recipient by fingerprint (see `recipient_fingerprint`).
    /// `label`, if given, must be encrypted to the owner's key.
    pub fn allow_hidden_recipient(&mut self, fingerprint: String, label: Option<String>) {
        self.assert_owner();
        let fingerprint = fingerprint.to_ascii_lowercase();
        require!(is_hex(&fingerprint, 64), "fingerprint must be 32 bytes of hex");
        if let Some(l) = &label {
            require!(is_encrypted(l), "label must be encrypted (enc1:...)");
        }
        let entry = match self.hidden.get(&fingerprint) {
            // Re-adding keeps the original add time, so it can't reset a cooldown trick.
            Some(e) => HiddenRecipient { label, ..e.clone() },
            None => HiddenRecipient {
                added_at_ms: env::block_timestamp_ms(),
                cooldown_ms: self.recipient_cooldown_ms,
                label,
            },
        };
        let payable_from = entry.added_at_ms + entry.cooldown_ms.min(self.recipient_cooldown_ms);
        self.hidden.insert(fingerprint.clone(), entry);
        event(
            "hidden_recipient_allowed",
            format!("{{\"fingerprint\":{},\"payable_from_ms\":{}}}", esc(&fingerprint), payable_from),
        );
    }

    pub fn disallow_hidden_recipient(&mut self, fingerprint: String) {
        self.assert_owner();
        let fingerprint = fingerprint.to_ascii_lowercase();
        self.hidden.remove(&fingerprint);
        event("hidden_recipient_removed", format!("{{\"fingerprint\":{}}}", esc(&fingerprint)));
    }

    /// `owner_encryption_key`: "x25519:<64 hex>", the public half of a key
    /// only the owner's dashboard can derive. `encrypted_memos_only`: reject
    /// any payment whose memo is plaintext.
    pub fn set_privacy(&mut self, owner_encryption_key: Option<String>, encrypted_memos_only: bool) {
        self.assert_owner();
        if let Some(k) = &owner_encryption_key {
            require!(
                k.starts_with(KEY_PREFIX) && is_hex(&k[KEY_PREFIX.len()..], 64),
                "key must be x25519:<64 lowercase hex>"
            );
        }
        require!(
            !encrypted_memos_only || owner_encryption_key.is_some(),
            "set an encryption key before requiring encrypted memos"
        );
        self.owner_encryption_key = owner_encryption_key;
        self.encrypted_memos_only = encrypted_memos_only;
        event(
            "privacy_set",
            format!(
                "{{\"owner_encryption_key\":{},\"encrypted_memos_only\":{}}}",
                self.owner_encryption_key.as_deref().map(esc).unwrap_or_else(|| "null".into()),
                encrypted_memos_only
            ),
        );
    }

    /// Approve the exact VM image + app a TEE agent must run. Returns its id.
    pub fn approve_tee_measurement(&mut self, measurement: TeeMeasurement) -> String {
        self.assert_owner();
        let m = measurement.normalized().unwrap_or_else(|e| env::panic_str(&e));
        let id = m.id();
        self.tee_measurements.insert(id.clone(), m.clone());
        event(
            "tee_measurement_approved",
            format!("{{\"id\":{},\"compose_hash\":{}}}", esc(&id), esc(&m.compose_hash)),
        );
        id
    }

    /// Agents attested under a removed measurement stop being able to spend
    /// at once (used when upgrading the agent image).
    pub fn remove_tee_measurement(&mut self, id: String) {
        self.assert_owner();
        require!(self.tee_measurements.remove(&id).is_some(), "unknown measurement");
        event("tee_measurement_removed", format!("{{\"id\":{}}}", esc(&id)));
    }

    /// Replace the list of approved CPUs (PPIDs, 16 bytes hex). Empty = any.
    pub fn set_tee_ppids(&mut self, ppids: Vec<String>) {
        self.assert_owner();
        self.tee_ppids.clear();
        for p in ppids {
            let p = p.to_ascii_lowercase();
            require!(is_hex(&p, 32), "ppid must be 16 bytes of hex");
            self.tee_ppids.insert(p);
        }
    }

    pub fn set_tee_policy(&mut self, require_tee: bool, attestation_ttl_ms: u64, allow_sw_hardening_needed: bool) {
        self.assert_owner();
        require!(attestation_ttl_ms >= 60_000, "attestation_ttl_ms too short");
        self.require_tee = require_tee;
        self.attestation_ttl_ms = attestation_ttl_ms;
        self.allow_sw_hardening_needed = allow_sw_hardening_needed;
        event(
            "tee_policy_set",
            format!(
                "{{\"require_tee\":{},\"attestation_ttl_ms\":{},\"allow_sw_hardening_needed\":{}}}",
                require_tee, attestation_ttl_ms, allow_sw_hardening_needed
            ),
        );
    }

    /// Owner withdraws an agent's attestation (e.g. its host is suspect).
    pub fn revoke_attestation(&mut self, agent: AccountId) {
        self.assert_owner();
        self.tee.remove(&agent);
        event("attestation_revoked", format!("{{\"agent\":{}}}", esc(agent.as_str())));
    }

    /// Called by a TEE agent itself, with a fresh TDX quote whose report_data
    /// is its own implicit account. The owner must already have added the
    /// agent with `add_agent`; this only proves where and what it runs.
    /// Panics with the reason if any check fails. Needs ~300 Tgas.
    pub fn attest_agent(&mut self, attestation: TeeAttestation) -> TeeInfo {
        let agent_id = env::predecessor_account_id();
        require!(self.agents.contains_key(&agent_id), "unknown agent: the owner must add it first");
        let report_data = tee::expected_report_data(agent_id.as_str()).unwrap_or_else(|e| env::panic_str(&e));
        let measurements: Vec<(String, TeeMeasurement)> =
            self.tee_measurements.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        require!(!measurements.is_empty(), "no approved TEE measurements");
        let ppids: Vec<String> = self.tee_ppids.iter().cloned().collect();
        let v = tee::verify(
            &attestation,
            &report_data,
            env::block_timestamp_ms() / 1000,
            self.allow_sw_hardening_needed,
            &measurements,
            &ppids,
        )
        .unwrap_or_else(|e| env::panic_str(&format!("attestation rejected: {}", e)));
        self.record_attestation(&agent_id, v)
    }

    /// Measurement-only (feature `tee-gas-probe`): run the full quote check at
    /// a chosen time so its gas can be measured with a sample quote.
    #[cfg(feature = "tee-gas-probe")]
    pub fn probe_tee_verify(&self, attestation: TeeAttestation, now_secs: u64, account: String) -> String {
        let rd = tee::expected_report_data(&account).unwrap_or_else(|e| env::panic_str(&e));
        let ms: Vec<(String, TeeMeasurement)> = self.tee_measurements.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        match tee::verify(&attestation, &rd, now_secs, true, &ms, &[]) {
            Ok(v) => format!("ok {}", v.measurement_id),
            Err(e) => e,
        }
    }

    pub fn set_shared_cap(&mut self, shared_cap: U128) {
        self.assert_owner();
        self.shared_cap = shared_cap.0;
    }

    /// Add a NEP-141 token agents may pay in, or update its symbol and shared
    /// cap. The vault must also be registered with the token contract
    /// (`storage_deposit`) before it can receive the token.
    pub fn add_token(&mut self, token: AccountId, symbol: String, decimals: u8, shared_cap: U128) {
        self.assert_owner();
        require!(!symbol.is_empty() && symbol.len() <= MAX_SYMBOL_LEN, "bad symbol");
        require!(decimals <= 24, "bad decimals");
        let t = match self.tokens.get(&token).cloned() {
            Some(mut t) => {
                t.symbol = symbol.clone();
                t.decimals = decimals;
                t.shared_cap = shared_cap;
                t
            }
            None => Token {
                symbol: symbol.clone(),
                decimals,
                balance: U128(0),
                shared_cap,
                shared_period: self.current_period(),
                shared_spent: U128(0),
                shared_reserved: U128(0),
                pending: U128(0),
                in_flight: U128(0),
            },
        };
        self.tokens.insert(token.clone(), t);
        event(
            "token_set",
            format!(
                "{{\"token\":{},\"symbol\":{},\"decimals\":{},\"shared_cap\":\"{}\"}}",
                esc(token.as_str()),
                esc(&symbol),
                decimals,
                shared_cap.0
            ),
        );
    }

    /// Set what an agent may spend in a token. An agent without limits for a
    /// token can't pay in it. Counters for the current period are kept.
    pub fn set_agent_token_limits(
        &mut self,
        agent: AccountId,
        token: AccountId,
        per_tx_max: U128,
        period_limit: U128,
        approval_threshold: U128,
    ) {
        self.assert_owner();
        require!(self.agents.contains_key(&agent), "unknown agent");
        require!(self.tokens.contains_key(&token), "unknown token");
        require!(per_tx_max.0 <= period_limit.0, "per_tx_max must be <= period_limit");
        let k = limits_key(&agent, &token);
        let (period_index, spent, reserved) = match self.token_limits.get(&k) {
            Some(l) => (l.period_index, l.spent, l.reserved),
            None => (self.current_period(), U128(0), U128(0)),
        };
        self.token_limits.insert(
            k,
            Limits { per_tx_max, period_limit, approval_threshold, period_index, spent, reserved },
        );
        event(
            "agent_token_set",
            format!(
                "{{\"agent\":{},\"token\":{},\"per_tx_max\":\"{}\",\"period_limit\":\"{}\",\"approval_threshold\":\"{}\"}}",
                esc(agent.as_str()),
                esc(token.as_str()),
                per_tx_max.0,
                period_limit.0,
                approval_threshold.0
            ),
        );
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        event("paused", "{}".to_string());
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        event("unpaused", "{}".to_string());
    }

    /// Owner approves a payment that was over the agent's approval threshold.
    pub fn approve(&mut self, key: String) -> Promise {
        self.assert_owner();
        require!(!self.paused, "vault is paused");
        let mut req = self.requests.get(&key).cloned().unwrap_or_else(|| env::panic_str("unknown request"));
        require!(req.status == Status::PendingApproval, "request is not pending approval");
        require!(!self.is_expired(&req), "approval window has passed");
        // Allowlist may have changed since the request was made.
        let still_allowed = match &req.recipient_fingerprint {
            Some(fp) => self.hidden.contains_key(fp),
            None => self.allowlist.contains(&req.recipient),
        };
        require!(still_allowed, "recipient no longer allowlisted");
        if let Some(o) = &req.origin {
            let open = self.tasks.get(&o.task_id).is_some_and(|t| !t.closed);
            require!(open, "task is closed");
        }
        self.adjust_pending(&req.token, req.amount.0, false);
        req.status = Status::InFlight;
        req.dispatched_at_ms = Some(env::block_timestamp_ms());
        self.requests.insert(key.clone(), req.clone());
        event("payment_approved", format!("{{\"key\":{}}}", esc(&key)));
        self.dispatch(&req)
    }

    /// Owner declines a pending payment; its budget is released.
    pub fn decline(&mut self, key: String) {
        self.assert_owner();
        let mut req = self.requests.get(&key).cloned().unwrap_or_else(|| env::panic_str("unknown request"));
        require!(req.status == Status::PendingApproval, "request is not pending approval");
        self.adjust_pending(&req.token, req.amount.0, false);
        self.release(&req);
        req.status = Status::Declined;
        self.store(req);
        event("payment_declined", format!("{{\"key\":{}}}", esc(&key)));
    }

    /// Release the budget of approvals nobody decided on in time. Anyone may
    /// call it; `request_payment` also does this on its own, so expired
    /// approvals never block an agent for long. Returns how many expired.
    pub fn expire_pending(&mut self, limit: Option<u32>) -> u32 {
        self.sweep_expired(limit.unwrap_or(SWEEP_LIMIT).min(MAX_OPEN))
    }

    /// Recovery for a payment whose transfer result never came back (its
    /// callback ran out of gas, for example). After IN_FLIGHT_RECOVERY_MS the
    /// owner records the outcome they can see on the explorer: `transferred`
    /// true settles it, false releases its budget (and, for a token, puts the
    /// amount back in the vault's tracked balance). A late callback after
    /// this is refused, so the payment still settles exactly once.
    pub fn reconcile_stuck(&mut self, key: String, transferred: bool) {
        self.assert_owner();
        let req = self.requests.get(&key).cloned().unwrap_or_else(|| env::panic_str("unknown request"));
        require!(req.status == Status::InFlight, "request is not in flight");
        let since = req.dispatched_at_ms.unwrap_or(req.created_at_ms);
        require!(
            env::block_timestamp_ms() >= since + IN_FLIGHT_RECOVERY_MS,
            "too early: the transfer result can still arrive"
        );
        event(
            "payment_reconciled",
            format!("{{\"key\":{},\"transferred\":{}}}", esc(&key), transferred),
        );
        if transferred {
            self.complete(req);
        } else {
            self.fail(req, "reconciled_by_owner");
        }
    }

    // ----------------------------------------------------------------- tasks

    /// Owner opens a task for an agent. Its payees are the only accounts the
    /// task can pay, and each must also be on the allowlist when paid.
    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        &mut self,
        id: String,
        agent: AccountId,
        description: String,
        payees: Vec<AccountId>,
        token: Option<AccountId>,
        budget: U128,
        max_per_payment: U128,
        trusted_sources: Vec<String>,
        expires_at_ms: u64,
    ) -> Task {
        self.assert_owner();
        require!(
            !id.is_empty()
                && id.len() <= MAX_TASK_ID_LEN
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.'),
            "bad task id: 1-64 of a-z A-Z 0-9 - _ ."
        );
        require!(!self.tasks.contains_key(&id), "task id already used");
        require!(self.tasks.len() < MAX_TASKS, "too many tasks: remove closed ones first");
        require!(self.agents.contains_key(&agent), "unknown agent");
        let enc = is_encrypted(&description);
        require!(
            description.len() <= if enc { MAX_ENC_LEN } else { MAX_TASK_DESCRIPTION_LEN },
            "description too long"
        );
        require!(!payees.is_empty() && payees.len() <= MAX_TASK_PAYEES, "a task needs 1-10 payees");
        let mut seen = std::collections::BTreeSet::new();
        for p in &payees {
            require!(seen.insert(p.clone()), "duplicate payee");
            require!(p != &agent && p != &env::current_account_id(), "payee not allowed");
        }
        require!(trusted_sources.len() <= MAX_TASK_SOURCES, "at most 10 trusted sources");
        for src in &trusted_sources {
            require!(valid_source(src), "bad trusted source: use kind:name, e.g. email:acme.com");
            // The runtime labels mail that fails DKIM as email:unverified.
            require!(!src.ends_with(":unverified"), "an unverified source can't be trusted");
        }
        if let Some(t) = &token {
            require!(self.tokens.contains_key(t), "token not supported");
        }
        require!(budget.0 > 0, "budget must be > 0");
        require!(max_per_payment.0 > 0 && max_per_payment.0 <= budget.0, "max_per_payment must be 1..=budget");
        let now = env::block_timestamp_ms();
        require!(expires_at_ms > now, "task must end in the future");
        let task = Task {
            id: id.clone(),
            agent,
            description,
            payees,
            token,
            budget,
            max_per_payment,
            trusted_sources,
            spent: U128(0),
            reserved: U128(0),
            created_at_ms: now,
            expires_at_ms,
            closed: false,
        };
        self.tasks.insert(id.clone(), task.clone());
        event(
            "task_created",
            format!(
                "{{\"task_id\":{},\"agent\":{},\"budget\":\"{}\",\"token\":{},\"expires_at_ms\":{}}}",
                esc(&id),
                esc(task.agent.as_str()),
                task.budget.0,
                esc_token(&task.token),
                task.expires_at_ms
            ),
        );
        task
    }

    /// Owner ends a task early. Payments already sent still settle against
    /// it; no new ones are accepted.
    pub fn close_task(&mut self, id: String) {
        self.assert_owner();
        let t = self.tasks.get_mut(&id).unwrap_or_else(|| env::panic_str("unknown task"));
        require!(!t.closed, "task already closed");
        t.closed = true;
        event("task_closed", format!("{{\"task_id\":{}}}", esc(&id)));
    }

    /// Owner deletes a closed or expired task that has nothing in flight.
    pub fn remove_task(&mut self, id: String) {
        self.assert_owner();
        let t = self.tasks.get(&id).unwrap_or_else(|| env::panic_str("unknown task"));
        require!(t.closed || env::block_timestamp_ms() >= t.expires_at_ms, "close the task first");
        require!(t.reserved.0 == 0, "task still has payments open");
        self.tasks.remove(&id);
        event("task_removed", format!("{{\"task_id\":{}}}", esc(&id)));
    }

    /// Owner vouches for (or stops vouching for) an agent's origin labels
    /// without a TEE attestation. Every payment records which applied.
    pub fn set_label_vouch(&mut self, agent: AccountId, vouched: bool) {
        self.assert_owner();
        if vouched {
            require!(self.agents.contains_key(&agent), "unknown agent");
            self.vouched.insert(agent.clone());
        } else {
            self.vouched.remove(&agent);
        }
        event("label_vouch", format!("{{\"agent\":{},\"vouched\":{}}}", esc(agent.as_str()), vouched));
    }

    /// Owner turns origin checks on for every payment. Needs a way to trust
    /// labels: an approved TEE measurement or a vouched agent.
    pub fn set_origin_policy(&mut self, require_origin: bool) {
        self.assert_owner();
        if require_origin {
            require!(
                !self.tee_measurements.is_empty() || !self.vouched.is_empty(),
                "approve a TEE measurement or vouch for an agent first"
            );
        }
        self.require_origin = require_origin;
        event("origin_policy", format!("{{\"require_origin\":{}}}", require_origin));
    }

    // ------------------------------------------------------------ agent entry

    /// The only method an agent can call. Intended to be reachable only
    /// through a function-call access key restricted to this method, so a
    /// compromised agent cannot move funds any other way.
    /// `recipient_salt` is only for recipients on the hidden allowlist.
    /// `origin` carries the attested runtime's labels for payments under a
    /// task (see `check_origin`).
    #[allow(clippy::too_many_arguments)]
    pub fn request_payment(
        &mut self,
        request_id: String,
        recipient: AccountId,
        amount: U128,
        memo: Option<String>,
        token: Option<AccountId>,
        recipient_salt: Option<String>,
        origin: Option<PaymentOrigin>,
    ) -> RequestOutcome {
        let agent_id = env::predecessor_account_id();
        let memo = memo.unwrap_or_default();
        require!(!request_id.is_empty() && request_id.len() <= MAX_REQUEST_ID_LEN, "bad request_id");
        let encrypted = is_encrypted(&memo);
        require!(memo.len() <= if encrypted { MAX_ENC_LEN } else { MAX_MEMO_LEN }, "memo too long");
        if let Some(o) = &origin {
            require!(
                !o.task_id.is_empty() && o.task_id.len() <= MAX_TASK_ID_LEN && valid_origin(&o.recipient) && valid_origin(&o.amount),
                "bad origin"
            );
        }

        // Free the budget of approvals that have run out of time first.
        self.sweep_expired(SWEEP_LIMIT);

        let key = format!("{}:{}", agent_id, request_id);
        if let Some(existing) = self.requests.get(&key) {
            event(
                "payment_duplicate",
                format!("{{\"key\":{},\"status\":\"{:?}\"}}", esc(&key), existing.status),
            );
            return RequestOutcome::Duplicate { key, status: existing.status.clone() };
        }

        // Origin first: when a payment is refused because its recipient came
        // from an email, that is the reason the owner should see.
        let checked = self
            .check_origin(&agent_id, &recipient, amount.0, &token, &origin)
            .and_then(|hold| {
                self.check_policy(&agent_id, &recipient, amount.0, &token, &recipient_salt, &memo).map(|fp| (fp, hold))
            });
        if let Err(reason) = checked {
            // Under the encrypted-memo rule a plaintext memo is not copied
            // into logs or state (the agent's own transaction is still public).
            let memo = if reason == "memo_not_encrypted" { String::new() } else { memo };
            event(
                "payment_rejected",
                format!(
                    "{{\"agent\":{},\"request_id\":{},\"recipient\":{},\"amount\":\"{}\",\"token\":{},\"reason\":{},\"memo\":{},\"origin\":{}}}",
                    esc(agent_id.as_str()),
                    esc(&request_id),
                    esc(recipient.as_str()),
                    amount.0,
                    esc_token(&token),
                    esc(&reason),
                    esc(&memo),
                    origin_json(&origin)
                ),
            );
            // Unknown callers are not recorded: anyone could spam them.
            if self.agents.contains_key(&agent_id) {
                self.record_blocked(BlockedAttempt {
                    agent: agent_id.clone(),
                    request_id: request_id.clone(),
                    recipient: recipient.clone(),
                    amount,
                    token: token.clone(),
                    reason: reason.clone(),
                    memo: if encrypted { memo.clone() } else { truncate(&memo, BLOCKED_MEMO_LEN) },
                    at_ms: env::block_timestamp_ms(),
                    origin: origin.clone(),
                });
            }
            return RequestOutcome::Rejected { reason };
        }
        let (recipient_fingerprint, (origin_hold, label_trust)) = checked.unwrap();

        // Reserve against agent + shared budgets before anything leaves.
        let period = self.current_period();
        let now = env::block_timestamp_ms();
        let mut limits = self.get_limits(&agent_id, &token).unwrap();
        limits.reserved = U128(limits.reserved.0 + amount.0);
        let hold_reason = match origin_hold {
            Some(r) => Some(r),
            None if amount.0 > limits.approval_threshold.0 => Some("over_approval_threshold".to_string()),
            None => None,
        };
        let needs_approval = hold_reason.is_some();
        self.put_limits(&agent_id, &token, limits);
        let mut pool = self.pool(&token);
        pool.reserved += amount.0;
        self.put_pool(&token, pool);
        if let Some(o) = &origin {
            let t = self.tasks.get_mut(&o.task_id).unwrap();
            t.reserved = U128(t.reserved.0 + amount.0);
        }

        let req = PaymentRequest {
            key: key.clone(),
            agent: agent_id.clone(),
            request_id: request_id.clone(),
            recipient: recipient.clone(),
            amount,
            token: token.clone(),
            memo: memo.clone(),
            recipient_fingerprint,
            status: if needs_approval { Status::PendingApproval } else { Status::InFlight },
            failure_reason: None,
            period_index: period,
            created_at_ms: now,
            dispatched_at_ms: if needs_approval { None } else { Some(now) },
            expires_at_ms: if needs_approval { Some(now + self.approval_ttl_ms) } else { None },
            seq: self.history_tail,
            origin: origin.clone(),
            hold_reason: hold_reason.clone(),
            label_trust,
        };
        if needs_approval {
            self.next_expiry_ms = self.next_expiry_ms.min(now + self.approval_ttl_ms);
        }
        self.requests.insert(key.clone(), req.clone());
        self.open.insert(key.clone());
        self.push_history(key.clone());
        let mut w = self.rolled_rate(&agent_id);
        w.count += 1;
        self.rate.insert(agent_id.clone(), w);

        let data = format!(
            "{{\"key\":{},\"agent\":{},\"recipient\":{},\"amount\":\"{}\",\"token\":{},\"memo\":{},\"origin\":{},\"hold_reason\":{}}}",
            esc(&key),
            esc(agent_id.as_str()),
            esc(recipient.as_str()),
            amount.0,
            esc_token(&token),
            esc(&memo),
            origin_json(&origin),
            hold_reason.as_deref().map(esc).unwrap_or_else(|| "null".into())
        );
        if needs_approval {
            self.adjust_pending(&token, amount.0, true);
            event("payment_pending_approval", data);
            RequestOutcome::PendingApproval { key }
        } else {
            event("payment_reserved", data);
            // The transfer and its callback are scheduled when the Promise is
            // dropped; the result arrives in on_payout.
            let _ = self.dispatch(&req);
            RequestOutcome::Dispatched { key }
        }
    }

    /// Result of a transfer (native or ft_transfer). Settles or releases the
    /// reservation exactly once.
    #[private]
    pub fn on_payout(&mut self, key: String) -> bool {
        let req = self.requests.get(&key).cloned().unwrap_or_else(|| env::panic_str("unknown request"));
        // Exactly-once: only an InFlight request can be reconciled.
        require!(req.status == Status::InFlight, "request already reconciled");
        // Read the raw result (bounded) so an odd token response can't make
        // this callback panic and leave the request stuck.
        let ok = env::promise_result_checked(0, MAX_RESULT_LEN).is_ok();
        if ok {
            self.complete(req);
        } else {
            // A failed native transfer's deposit is refunded by the protocol;
            // a failed ft_transfer never moved the tokens.
            self.fail(req, "transfer_failed");
        }
        ok
    }

    /// Token payments only: the recipient must be registered with the token
    /// contract, or ft_transfer would fail. If it is, send the tokens.
    #[private]
    pub fn on_recipient_checked(&mut self, key: String) -> PromiseOrValue<bool> {
        let req = self.requests.get(&key).cloned().unwrap_or_else(|| env::panic_str("unknown request"));
        require!(req.status == Status::InFlight, "request already reconciled");
        let registered = match env::promise_result_checked(0, MAX_RESULT_LEN) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&bytes)
                .map(|v| !v.is_null())
                .unwrap_or(false),
            Err(_) => false,
        };
        if !registered {
            self.fail(req, "recipient_not_registered");
            return PromiseOrValue::Value(false);
        }
        let token = req.token.clone().unwrap();
        PromiseOrValue::Promise(
            ext_ft::ext(token)
                .with_static_gas(FT_TRANSFER_GAS)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .ft_transfer(req.recipient.clone(), req.amount, None)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_payout(key),
                ),
        )
    }

    // ------------------------------------------------------------------ views

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            paused: self.paused,
            period_ms: self.period_ms,
            shared_cap: U128(self.shared_cap),
            current_period: self.current_period(),
            recipient_cooldown_ms: self.recipient_cooldown_ms,
            max_payments_per_hour: self.max_payments_per_hour,
            owner_encryption_key: self.owner_encryption_key.clone(),
            encrypted_memos_only: self.encrypted_memos_only,
            require_tee: self.require_tee,
            pending_owner: self.pending_owner.clone(),
            approval_ttl_ms: self.approval_ttl_ms,
            history_limit: self.history_limit,
            in_flight_recovery_ms: IN_FLIGHT_RECOVERY_MS,
            open_payments: self.open.len(),
            require_origin: self.require_origin,
        }
    }

    /// Hidden allowlist entries: fingerprints only.
    pub fn list_hidden_recipients(&self) -> Vec<HiddenRecipientView> {
        self.hidden
            .iter()
            .map(|(fp, e)| HiddenRecipientView {
                fingerprint: fp.clone(),
                added_at_ms: e.added_at_ms,
                payable_from_ms: e.added_at_ms + e.cooldown_ms.min(self.recipient_cooldown_ms),
                label: e.label.clone(),
            })
            .collect()
    }

    pub fn get_task(&self, id: String) -> Option<Task> {
        self.tasks.get(&id).cloned()
    }

    pub fn list_tasks(&self) -> Vec<Task> {
        self.tasks.values().cloned().collect()
    }

    pub fn list_vouched(&self) -> Vec<AccountId> {
        self.vouched.iter().cloned().collect()
    }

    pub fn get_tee_policy(&self) -> TeePolicy {
        TeePolicy {
            require_tee: self.require_tee,
            attestation_ttl_ms: self.attestation_ttl_ms,
            allow_sw_hardening_needed: self.allow_sw_hardening_needed,
            measurements: self.tee_measurements.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            ppids: self.tee_ppids.iter().cloned().collect(),
        }
    }

    pub fn get_agent_tee(&self, agent: AccountId) -> Option<TeeInfo> {
        self.tee.get(&agent).cloned()
    }

    /// Attestations of every agent that has one.
    pub fn list_agent_tee(&self) -> Vec<(AccountId, TeeInfo)> {
        self.agents
            .keys()
            .filter_map(|a| self.tee.get(a).map(|t| (a.clone(), t.clone())))
            .collect()
    }

    /// Allowed recipients with when each can first be paid.
    pub fn list_recipients(&self) -> Vec<Recipient> {
        self.allowlist
            .iter()
            .map(|r| Recipient {
                account: r.clone(),
                added_at_ms: self.recipient_added_at.get(r).map(|x| x.0).unwrap_or(0),
                payable_from_ms: self.payable_from(r),
            })
            .collect()
    }

    /// Payment requests this agent made in the current one-hour window.
    pub fn get_agent_rate(&self, agent: AccountId) -> RateWindow {
        self.rolled_rate(&agent)
    }

    /// Agent with counters as they apply to the current period.
    pub fn get_agent(&self, agent: AccountId) -> Option<Agent> {
        self.agents.get(&agent).map(|a| self.rolled_agent(a))
    }

    pub fn list_agents(&self) -> Vec<(AccountId, Agent)> {
        self.agents.iter().map(|(k, a)| (k.clone(), self.rolled_agent(a))).collect()
    }

    pub fn list_allowlist(&self) -> Vec<AccountId> {
        self.allowlist.iter().cloned().collect()
    }

    pub fn get_request(&self, key: String) -> Option<PaymentRequest> {
        self.requests.get(&key).cloned()
    }

    /// Most recent first. Only the last `history_limit` payments are kept.
    pub fn list_requests(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<PaymentRequest> {
        let len = self.history_tail - self.history_head;
        let skip = (from_index.unwrap_or(0) as u64).min(len);
        let limit = limit.unwrap_or(50).min(100) as u64;
        let newest = self.history_tail - skip;
        (newest.saturating_sub(limit).max(self.history_head)..newest)
            .rev()
            .filter_map(|i| self.history.get(&i))
            .filter_map(|k| self.requests.get(k).cloned())
            .collect()
    }

    /// Payments waiting for approval or for their transfer result.
    pub fn list_open(&self) -> Vec<PaymentRequest> {
        self.open.iter().filter_map(|k| self.requests.get(k).cloned()).collect()
    }

    /// Most recent blocked attempts first (up to 50 kept).
    pub fn list_blocked(&self, limit: Option<u32>) -> Vec<BlockedAttempt> {
        let len = self.blocked.len();
        let limit = limit.unwrap_or(BLOCKED_LOG_SIZE).min(BLOCKED_LOG_SIZE) as u64;
        let total = self.blocked_total;
        (0..total.min(len as u64).min(limit))
            .map(|i| ((total - 1 - i) % BLOCKED_LOG_SIZE as u64) as u32)
            .filter_map(|idx| self.blocked.get(idx).cloned())
            .collect()
    }

    /// How many attempts have been blocked since deployment (registered agents only).
    pub fn blocked_count(&self) -> u64 {
        self.blocked_total
    }

    /// Tokens the vault supports, with balances and shared budget as they
    /// apply to the current period.
    pub fn list_tokens(&self) -> Vec<TokenView> {
        self.tokens
            .iter()
            .map(|(id, t)| {
                let tid = Some(id.clone());
                let rolled_spent = if t.shared_period == self.current_period() { t.shared_spent } else { U128(0) };
                TokenView {
                    token: id.clone(),
                    symbol: t.symbol.clone(),
                    decimals: t.decimals,
                    balance: t.balance,
                    pending_approval: t.pending,
                    in_flight: t.in_flight,
                    available: U128(self.available(&tid)),
                    shared_cap: t.shared_cap,
                    shared_spent: rolled_spent,
                    shared_reserved: t.shared_reserved,
                }
            })
            .collect()
    }

    /// An agent's limits for each token it may pay in, rolled to the current period.
    pub fn get_agent_token_limits(&self, agent: AccountId) -> Vec<(AccountId, Limits)> {
        self.tokens
            .keys()
            .filter_map(|t| self.token_limits.get(&limits_key(&agent, t)).map(|l| (t.clone(), self.rolled(l.clone()))))
            .collect()
    }

    pub fn get_balances(&self) -> Balances {
        let (spent, reserved) = self.rolled_shared();
        Balances {
            vault_balance: U128(env::account_balance().as_yoctonear()),
            operating_reserve: U128(OPERATING_RESERVE.as_yoctonear()),
            storage_cost: U128(self.storage_cost()),
            pending_approval: U128(self.pending_total),
            in_flight: U128(self.in_flight_total),
            available: U128(self.available(&None)),
            shared_spent: U128(spent),
            shared_reserved: U128(reserved),
            shared_cap: U128(self.shared_cap),
        }
    }

    // --------------------------------------------------------------- internal

    fn record_blocked(&mut self, b: BlockedAttempt) {
        let slot = (self.blocked_total % BLOCKED_LOG_SIZE as u64) as u32;
        if slot < self.blocked.len() {
            self.blocked.set(slot, b);
        } else {
            self.blocked.push(b);
        }
        self.blocked_total += 1;
    }

    fn payable_from(&self, recipient: &AccountId) -> u64 {
        match self.recipient_added_at.get(recipient) {
            Some((at, cooldown)) => at + (*cooldown).min(self.recipient_cooldown_ms),
            None => 0,
        }
    }

    fn rolled_rate(&self, agent: &AccountId) -> RateWindow {
        let now = env::block_timestamp_ms();
        match self.rate.get(agent) {
            Some(w) if now < w.window_start_ms + RATE_WINDOW_MS => w.clone(),
            _ => RateWindow { window_start_ms: now, count: 0 },
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn current_period(&self) -> u64 {
        env::block_timestamp_ms() / self.period_ms
    }

    fn storage_cost(&self) -> u128 {
        env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128
    }

    /// Spendable now. NEAR: balance minus storage, operating reserve, and
    /// money promised to pending approvals (in-flight transfers have already
    /// left the balance). Tokens: tracked balance minus pending approvals.
    fn available(&self, token: &Option<AccountId>) -> u128 {
        match token {
            None => env::account_balance()
                .as_yoctonear()
                .saturating_sub(self.storage_cost())
                .saturating_sub(OPERATING_RESERVE.as_yoctonear())
                .saturating_sub(self.pending_total),
            Some(t) => self
                .tokens
                .get(t)
                .map(|t| t.balance.0.saturating_sub(t.pending.0))
                .unwrap_or(0),
        }
    }

    /// When a new period starts, spent resets but outstanding reservations
    /// carry over (they are still promised money), which keeps the
    /// invariant conservative.
    fn rolled(&self, mut l: Limits) -> Limits {
        let p = self.current_period();
        if l.period_index != p {
            l.period_index = p;
            l.spent = U128(0);
        }
        l
    }

    fn rolled_agent(&self, a: &Agent) -> Agent {
        let mut a = a.clone();
        let p = self.current_period();
        if a.period_index != p {
            a.period_index = p;
            a.spent = U128(0);
        }
        a
    }

    fn rolled_shared(&self) -> (u128, u128) {
        if self.shared_period != self.current_period() {
            (0, self.shared_reserved)
        } else {
            (self.shared_spent, self.shared_reserved)
        }
    }

    fn get_limits(&self, agent: &AccountId, token: &Option<AccountId>) -> Option<Limits> {
        match token {
            None => self.agents.get(agent).map(|a| Limits {
                per_tx_max: a.per_tx_max,
                period_limit: a.period_limit,
                approval_threshold: a.approval_threshold,
                period_index: a.period_index,
                spent: a.spent,
                reserved: a.reserved,
            }),
            Some(t) => self.token_limits.get(&limits_key(agent, t)).cloned(),
        }
    }

    fn put_limits(&mut self, agent: &AccountId, token: &Option<AccountId>, l: Limits) {
        match token {
            None => {
                if let Some(a) = self.agents.get_mut(agent) {
                    a.period_index = l.period_index;
                    a.spent = l.spent;
                    a.reserved = l.reserved;
                }
            }
            Some(t) => {
                self.token_limits.insert(limits_key(agent, t), l);
            }
        }
    }

    fn pool(&self, token: &Option<AccountId>) -> Pool {
        match token {
            None => Pool {
                cap: self.shared_cap,
                period: self.shared_period,
                spent: self.shared_spent,
                reserved: self.shared_reserved,
                pending: self.pending_total,
                in_flight: self.in_flight_total,
            },
            Some(t) => {
                let t = self.tokens.get(t).unwrap_or_else(|| env::panic_str("unknown token"));
                Pool {
                    cap: t.shared_cap.0,
                    period: t.shared_period,
                    spent: t.shared_spent.0,
                    reserved: t.shared_reserved.0,
                    pending: t.pending.0,
                    in_flight: t.in_flight.0,
                }
            }
        }
    }

    fn put_pool(&mut self, token: &Option<AccountId>, p: Pool) {
        match token {
            None => {
                self.shared_period = p.period;
                self.shared_spent = p.spent;
                self.shared_reserved = p.reserved;
                self.pending_total = p.pending;
                self.in_flight_total = p.in_flight;
            }
            Some(t) => {
                let t = self.tokens.get_mut(t).unwrap_or_else(|| env::panic_str("unknown token"));
                t.shared_period = p.period;
                t.shared_spent = U128(p.spent);
                t.shared_reserved = U128(p.reserved);
                t.pending = U128(p.pending);
                t.in_flight = U128(p.in_flight);
            }
        }
    }

    fn adjust_pending(&mut self, token: &Option<AccountId>, amount: u128, add: bool) {
        let mut p = self.pool(token);
        p.pending = if add { p.pending + amount } else { p.pending - amount };
        self.put_pool(token, p);
    }

    /// In-flight token amounts also leave the tracked token balance while the
    /// transfer is pending, mirroring how a native transfer leaves the account
    /// balance; they come back if it fails.
    fn adjust_in_flight(&mut self, token: &Option<AccountId>, amount: u128, add: bool) {
        let mut p = self.pool(token);
        p.in_flight = if add { p.in_flight + amount } else { p.in_flight - amount };
        self.put_pool(token, p);
    }

    fn roll(&mut self, agent_id: &AccountId, token: &Option<AccountId>) {
        let cur = self.current_period();
        let mut p = self.pool(token);
        if p.period != cur {
            p.period = cur;
            p.spent = 0;
            self.put_pool(token, p);
        }
        if let Some(l) = self.get_limits(agent_id, token) {
            let rolled = self.rolled(l);
            self.put_limits(agent_id, token, rolled);
        }
    }

    /// Ok(Some(fingerprint)) when the recipient matched the hidden allowlist.
    /// Why an agent's attestation can't be relied on right now, if it can't.
    fn attestation_problem(&self, agent_id: &AccountId) -> Option<String> {
        match self.tee.get(agent_id) {
            None => Some("agent_not_attested".into()),
            Some(t) if env::block_timestamp_ms() >= t.valid_until_ms => Some("attestation_expired".into()),
            Some(t) if !self.tee_measurements.contains_key(&t.measurement_id) => {
                Some("agent_measurement_not_approved".into())
            }
            Some(_) => None,
        }
    }

    /// The CaMeL rule, on-chain. Labels are only trusted from an agent whose
    /// TDX attestation is valid for an approved measurement. Then:
    /// - the recipient must be owner-origin AND one of the task's payees
    ///   (the contract checks the payee list itself);
    /// - the amount must fit the task's per-payment cap and budget;
    /// - an amount from a source the task doesn't trust is held for the owner.
    /// Returns (hold reason if it must wait for the owner, why the labels
    /// were trusted).
    fn check_origin(
        &self,
        agent_id: &AccountId,
        recipient: &AccountId,
        amount: u128,
        token: &Option<AccountId>,
        origin: &Option<PaymentOrigin>,
    ) -> Result<(Option<String>, Option<String>), String> {
        let Some(o) = origin else {
            return if self.require_origin { Err("origin_required".into()) } else { Ok((None, None)) };
        };
        if !self.agents.contains_key(agent_id) {
            return Err("unknown_agent".into());
        }
        let trust = if self.vouched.contains(agent_id) {
            "owner_vouched"
        } else if let Some(reason) = self.attestation_problem(agent_id) {
            return Err(reason);
        } else {
            "tee"
        };
        let Some(t) = self.tasks.get(&o.task_id) else {
            return Err("task_not_found".into());
        };
        if &t.agent != agent_id {
            return Err("task_not_for_agent".into());
        }
        if t.closed {
            return Err("task_closed".into());
        }
        if env::block_timestamp_ms() >= t.expires_at_ms {
            return Err("task_expired".into());
        }
        if &t.token != token {
            return Err("task_token_mismatch".into());
        }
        if o.recipient != Origin::Owner {
            return Err("recipient_from_untrusted_source".into());
        }
        if !t.payees.contains(recipient) {
            return Err("recipient_not_in_task".into());
        }
        if amount > t.max_per_payment.0 {
            return Err("exceeds_task_max_per_payment".into());
        }
        if t.spent.0 + t.reserved.0 + amount > t.budget.0 {
            return Err("exceeds_task_budget".into());
        }
        let hold = match &o.amount {
            Origin::Owner => None,
            Origin::Source { source, .. } if t.trusted_sources.contains(source) => None,
            Origin::Source { .. } => Some("amount_from_untrusted_source".into()),
        };
        Ok((hold, Some(trust.to_string())))
    }

    fn check_policy(
        &mut self,
        agent_id: &AccountId,
        recipient: &AccountId,
        amount: u128,
        token: &Option<AccountId>,
        salt: &Option<String>,
        memo: &str,
    ) -> Result<Option<String>, String> {
        if self.paused {
            return Err("vault_paused".into());
        }
        let Some(agent) = self.agents.get(agent_id) else {
            return Err("unknown_agent".into());
        };
        if !agent.active {
            return Err("agent_disabled".into());
        }
        if self.require_tee {
            if let Some(reason) = self.attestation_problem(agent_id) {
                return Err(reason);
            }
        }
        if amount == 0 {
            return Err("zero_amount".into());
        }
        if let Some(t) = token {
            if !self.tokens.contains_key(t) {
                return Err("token_not_supported".into());
            }
        }
        if recipient == &env::current_account_id() || recipient == agent_id {
            return Err("recipient_not_allowed".into());
        }
        let (fingerprint, payable_from) = if self.allowlist.contains(recipient) {
            (None, self.payable_from(recipient))
        } else {
            let hit = salt
                .as_ref()
                .and_then(|s| recipient_fingerprint(recipient, s))
                .and_then(|fp| self.hidden.get(&fp).map(|e| (fp, e.added_at_ms + e.cooldown_ms.min(self.recipient_cooldown_ms))));
            match hit {
                Some((fp, from)) => (Some(fp), from),
                None => return Err("recipient_not_allowlisted".into()),
            }
        };
        if env::block_timestamp_ms() < payable_from {
            return Err("recipient_in_cooldown".into());
        }
        if self.encrypted_memos_only && !memo.is_empty() && !is_encrypted(memo) {
            return Err("memo_not_encrypted".into());
        }
        if self.open.len() >= MAX_OPEN {
            return Err("too_many_open_payments".into());
        }
        if self.max_payments_per_hour > 0 && self.rolled_rate(agent_id).count >= self.max_payments_per_hour {
            return Err("exceeds_payment_rate".into());
        }
        if self.get_limits(agent_id, token).is_none() {
            return Err("token_not_enabled_for_agent".into());
        }
        self.roll(agent_id, token);
        let l = self.get_limits(agent_id, token).unwrap();
        if amount > l.per_tx_max.0 {
            return Err("exceeds_per_request_max".into());
        }
        if l.spent.0 + l.reserved.0 + amount > l.period_limit.0 {
            return Err("exceeds_agent_period_limit".into());
        }
        let p = self.pool(token);
        if p.spent + p.reserved + amount > p.cap {
            return Err("exceeds_shared_cap".into());
        }
        if amount > self.available(token) {
            return Err("insufficient_vault_balance".into());
        }
        Ok(fingerprint)
    }

    fn record_attestation(&mut self, agent_id: &AccountId, v: tee::Verified) -> TeeInfo {
        let now = env::block_timestamp_ms();
        let info = TeeInfo {
            measurement_id: v.measurement_id,
            compose_hash: v.compose_hash,
            ppid: v.ppid,
            tcb_status: v.tcb_status,
            attested_at_ms: now,
            valid_until_ms: now + self.attestation_ttl_ms,
        };
        self.tee.insert(agent_id.clone(), info.clone());
        event(
            "agent_attested",
            format!(
                "{{\"agent\":{},\"measurement_id\":{},\"compose_hash\":{},\"ppid\":{},\"tcb_status\":{},\"valid_until_ms\":{}}}",
                esc(agent_id.as_str()),
                esc(&info.measurement_id),
                esc(&info.compose_hash),
                esc(&info.ppid),
                esc(&info.tcb_status),
                info.valid_until_ms
            ),
        );
        info
    }

    fn dispatch(&mut self, req: &PaymentRequest) -> Promise {
        self.adjust_in_flight(&req.token, req.amount.0, true);
        event(
            "payment_dispatched",
            format!(
                "{{\"key\":{},\"recipient\":{},\"amount\":\"{}\",\"token\":{}}}",
                esc(&req.key),
                esc(req.recipient.as_str()),
                req.amount.0,
                esc_token(&req.token)
            ),
        );
        match &req.token {
            None => Promise::new(req.recipient.clone())
                .transfer(NearToken::from_yoctonear(req.amount.0))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_payout(req.key.clone()),
                ),
            Some(token) => {
                let t = self.tokens.get_mut(token).unwrap();
                t.balance = U128(t.balance.0 - req.amount.0);
                ext_ft::ext(token.clone())
                    .with_static_gas(FT_CHECK_GAS)
                    .storage_balance_of(req.recipient.clone())
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(RECIPIENT_CHECK_GAS)
                            .on_recipient_checked(req.key.clone()),
                    )
            }
        }
    }

    /// Mark an in-flight payment failed: release its budget and, for a
    /// token, put the amount back in the tracked balance.
    fn fail(&mut self, mut req: PaymentRequest, reason: &str) {
        self.adjust_in_flight(&req.token, req.amount.0, false);
        if let Some(token) = &req.token {
            if let Some(t) = self.tokens.get_mut(token) {
                t.balance = U128(t.balance.0 + req.amount.0);
            }
        }
        self.release(&req);
        req.status = Status::Failed;
        req.failure_reason = Some(reason.to_string());
        let stored = req.clone();
        event(
            "payment_failed",
            format!(
                "{{\"key\":{},\"amount\":\"{}\",\"token\":{},\"reason\":{}}}",
                esc(&req.key),
                req.amount.0,
                esc_token(&req.token),
                esc(reason)
            ),
        );
        self.store(stored);
    }

    /// A transfer went through: move its reservation to spent.
    fn complete(&mut self, mut req: PaymentRequest) {
        self.adjust_in_flight(&req.token, req.amount.0, false);
        self.settle(&req);
        req.status = Status::Settled;
        event(
            "payment_settled",
            format!("{{\"key\":{},\"amount\":\"{}\",\"token\":{}}}", esc(&req.key), req.amount.0, esc_token(&req.token)),
        );
        self.store(req);
    }

    /// Save a request; a finished one leaves the open set. A finished record
    /// that has already dropped out of the history window is deleted.
    fn store(&mut self, req: PaymentRequest) {
        let key = req.key.clone();
        if req.status.is_final() {
            self.open.remove(&key);
            if req.seq < self.history_head {
                self.requests.remove(&key);
                return;
            }
        }
        self.requests.insert(key, req);
    }

    fn is_expired(&self, req: &PaymentRequest) -> bool {
        req.status == Status::PendingApproval
            && req.expires_at_ms.is_some_and(|t| env::block_timestamp_ms() >= t)
    }

    /// Expire up to `limit` overdue approvals. Cheap when nothing is due.
    fn sweep_expired(&mut self, limit: u32) -> u32 {
        let now = env::block_timestamp_ms();
        if now < self.next_expiry_ms || limit == 0 {
            return 0;
        }
        let mut due = Vec::new();
        let mut next = u64::MAX;
        for k in self.open.iter() {
            let Some(r) = self.requests.get(k) else { continue };
            if let (Status::PendingApproval, Some(t)) = (&r.status, r.expires_at_ms) {
                if now >= t && (due.len() as u32) < limit {
                    due.push(k.clone());
                } else {
                    next = next.min(t);
                }
            }
        }
        // Left over (over the limit) items are due now, so next stays <= now.
        self.next_expiry_ms = next;
        let n = due.len() as u32;
        for k in due {
            let mut req = self.requests.get(&k).cloned().unwrap();
            self.adjust_pending(&req.token, req.amount.0, false);
            self.release(&req);
            req.status = Status::Expired;
            event("payment_expired", format!("{{\"key\":{}}}", esc(&k)));
            self.store(req);
        }
        n
    }

    /// Record a new payment key and trim the oldest records past the limit.
    fn push_history(&mut self, key: String) {
        self.history.insert(self.history_tail, key);
        self.history_tail += 1;
        let mut pruned = 0;
        while self.history_tail - self.history_head > self.history_limit as u64 && pruned < PRUNE_PER_INSERT {
            let idx = self.history_head;
            if let Some(old) = self.history.remove(&idx) {
                // An unfinished payment keeps its record (it is still in the
                // open set and reachable with get_request / list_open).
                if self.requests.get(&old).is_some_and(|r| r.status.is_final()) {
                    self.requests.remove(&old);
                }
            }
            self.history_head += 1;
            pruned += 1;
        }
    }

    /// Move a reservation to spent (only counts toward spent if it is still
    /// the period it was reserved in).
    fn settle(&mut self, req: &PaymentRequest) {
        self.roll(&req.agent, &req.token);
        let cur = self.current_period();
        if let Some(mut l) = self.get_limits(&req.agent, &req.token) {
            l.reserved = U128(l.reserved.0 - req.amount.0);
            if req.period_index == cur {
                l.spent = U128(l.spent.0 + req.amount.0);
            }
            self.put_limits(&req.agent, &req.token, l);
        }
        let mut p = self.pool(&req.token);
        p.reserved -= req.amount.0;
        if req.period_index == cur {
            p.spent += req.amount.0;
        }
        self.put_pool(&req.token, p);
        self.task_done(req, true);
    }

    /// Move a task payment's reservation to spent (paid) or back (not paid).
    fn task_done(&mut self, req: &PaymentRequest, paid: bool) {
        let Some(o) = &req.origin else { return };
        if let Some(t) = self.tasks.get_mut(&o.task_id) {
            t.reserved = U128(t.reserved.0 - req.amount.0);
            if paid {
                t.spent = U128(t.spent.0 + req.amount.0);
            }
        }
    }

    fn release(&mut self, req: &PaymentRequest) {
        if let Some(mut l) = self.get_limits(&req.agent, &req.token) {
            l.reserved = U128(l.reserved.0 - req.amount.0);
            self.put_limits(&req.agent, &req.token, l);
        }
        let mut p = self.pool(&req.token);
        p.reserved -= req.amount.0;
        self.put_pool(&req.token, p);
        self.task_done(req, false);
    }
}

/// Unit tests: initialize as the vault account itself (as a deploy with an
/// init call does), then put the caller and the rest of the context back.
#[cfg(test)]
pub(crate) fn init_for_test(owner: AccountId, period_ms: u64, shared_cap: U128) -> Banbo {
    use near_sdk::test_utils::VMContextBuilder;
    let (me, caller, balance, ts) =
        (env::current_account_id(), env::predecessor_account_id(), env::account_balance(), env::block_timestamp());
    let ctx = |pred: AccountId| {
        VMContextBuilder::new().current_account_id(me.clone()).predecessor_account_id(pred)
            .account_balance(balance).block_timestamp(ts).build()
    };
    near_sdk::testing_env!(ctx(me.clone()));
    let c = Banbo::new(owner, period_ms, shared_cap);
    near_sdk::testing_env!(ctx(caller));
    c
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_private;
#[cfg(test)]
mod tests_hardening;
#[cfg(test)]
mod tests_origin;
