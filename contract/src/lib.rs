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
//! Core invariant, per agent and for the shared treasury, per asset, in the
//! current period:
//!     spent + reserved <= limit
//! and every request id settles at most once.

use near_sdk::json_types::U128;
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
const MAX_REQUEST_ID_LEN: usize = 64;
/// Blocked attempts kept on-chain for the dashboard (oldest overwritten).
const BLOCKED_LOG_SIZE: u32 = 50;
const BLOCKED_MEMO_LEN: usize = 80;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    Allowlist,
    Requests,
    RequestOrder,
    Blocked,
    Tokens,
    TokenLimits,
    RecipientAddedAt,
    Rate,
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
    pub status: Status,
    /// Why a Failed payment failed: transfer_failed or recipient_not_registered.
    pub failure_reason: Option<String>,
    pub period_index: u64,
    pub created_at_ms: u64,
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
    /// Truncated to 80 bytes.
    pub memo: String,
    pub at_ms: u64,
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
    agents: IterableMap<AccountId, Agent>,
    allowlist: IterableSet<AccountId>,
    requests: LookupMap<String, PaymentRequest>,
    request_order: Vector<String>,
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

fn limits_key(agent: &AccountId, token: &AccountId) -> String {
    format!("{}|{}", agent, token)
}

#[near]
impl Banbo {
    #[init]
    pub fn new(owner: AccountId, period_ms: u64, shared_cap: U128) -> Self {
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
            agents: IterableMap::new(StorageKey::Agents),
            allowlist: IterableSet::new(StorageKey::Allowlist),
            requests: LookupMap::new(StorageKey::Requests),
            request_order: Vector::new(StorageKey::RequestOrder),
            blocked: Vector::new(StorageKey::Blocked),
            blocked_total: 0,
            tokens: IterableMap::new(StorageKey::Tokens),
            token_limits: LookupMap::new(StorageKey::TokenLimits),
            recipient_cooldown_ms: 0,
            max_payments_per_hour: 0,
            recipient_added_at: LookupMap::new(StorageKey::RecipientAddedAt),
            rate: LookupMap::new(StorageKey::Rate),
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
        // Allowlist may have changed since the request was made.
        require!(self.allowlist.contains(&req.recipient), "recipient no longer allowlisted");
        self.adjust_pending(&req.token, req.amount.0, false);
        req.status = Status::InFlight;
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
        self.requests.insert(key.clone(), req);
        event("payment_declined", format!("{{\"key\":{}}}", esc(&key)));
    }

    // ------------------------------------------------------------ agent entry

    /// The only method an agent can call. Intended to be reachable only
    /// through a function-call access key restricted to this method, so a
    /// compromised agent cannot move funds any other way.
    pub fn request_payment(
        &mut self,
        request_id: String,
        recipient: AccountId,
        amount: U128,
        memo: Option<String>,
        token: Option<AccountId>,
    ) -> RequestOutcome {
        let agent_id = env::predecessor_account_id();
        let memo = memo.unwrap_or_default();
        require!(!request_id.is_empty() && request_id.len() <= MAX_REQUEST_ID_LEN, "bad request_id");
        require!(memo.len() <= MAX_MEMO_LEN, "memo too long");

        let key = format!("{}:{}", agent_id, request_id);
        if let Some(existing) = self.requests.get(&key) {
            event(
                "payment_duplicate",
                format!("{{\"key\":{},\"status\":\"{:?}\"}}", esc(&key), existing.status),
            );
            return RequestOutcome::Duplicate { key, status: existing.status.clone() };
        }

        if let Err(reason) = self.check_policy(&agent_id, &recipient, amount.0, &token) {
            event(
                "payment_rejected",
                format!(
                    "{{\"agent\":{},\"request_id\":{},\"recipient\":{},\"amount\":\"{}\",\"token\":{},\"reason\":{},\"memo\":{}}}",
                    esc(agent_id.as_str()),
                    esc(&request_id),
                    esc(recipient.as_str()),
                    amount.0,
                    esc_token(&token),
                    esc(&reason),
                    esc(&memo)
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
                    memo: truncate(&memo, BLOCKED_MEMO_LEN),
                    at_ms: env::block_timestamp_ms(),
                });
            }
            return RequestOutcome::Rejected { reason };
        }

        // Reserve against agent + shared budgets before anything leaves.
        let period = self.current_period();
        let mut limits = self.get_limits(&agent_id, &token).unwrap();
        limits.reserved = U128(limits.reserved.0 + amount.0);
        let needs_approval = amount.0 > limits.approval_threshold.0;
        self.put_limits(&agent_id, &token, limits);
        let mut pool = self.pool(&token);
        pool.reserved += amount.0;
        self.put_pool(&token, pool);

        let req = PaymentRequest {
            key: key.clone(),
            agent: agent_id.clone(),
            request_id: request_id.clone(),
            recipient: recipient.clone(),
            amount,
            token: token.clone(),
            memo: memo.clone(),
            status: if needs_approval { Status::PendingApproval } else { Status::InFlight },
            failure_reason: None,
            period_index: period,
            created_at_ms: env::block_timestamp_ms(),
        };
        self.requests.insert(key.clone(), req.clone());
        self.request_order.push(key.clone());
        let mut w = self.rolled_rate(&agent_id);
        w.count += 1;
        self.rate.insert(agent_id.clone(), w);

        let data = format!(
            "{{\"key\":{},\"agent\":{},\"recipient\":{},\"amount\":\"{}\",\"token\":{},\"memo\":{}}}",
            esc(&key),
            esc(agent_id.as_str()),
            esc(recipient.as_str()),
            amount.0,
            esc_token(&token),
            esc(&memo)
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
            self.adjust_in_flight(&req.token, req.amount.0, false);
            self.settle(&req);
            let mut req = req;
            req.status = Status::Settled;
            event(
                "payment_settled",
                format!("{{\"key\":{},\"amount\":\"{}\",\"token\":{}}}", esc(&key), req.amount.0, esc_token(&req.token)),
            );
            self.requests.insert(key, req);
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
        }
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

    /// Most recent first.
    pub fn list_requests(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<PaymentRequest> {
        let len = self.request_order.len();
        let skip = from_index.unwrap_or(0).min(len);
        let limit = limit.unwrap_or(50).min(100);
        (0..len - skip)
            .rev()
            .take(limit as usize)
            .filter_map(|i| self.request_order.get(i))
            .filter_map(|k| self.requests.get(k).cloned())
            .collect()
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

    fn check_policy(
        &mut self,
        agent_id: &AccountId,
        recipient: &AccountId,
        amount: u128,
        token: &Option<AccountId>,
    ) -> Result<(), String> {
        if self.paused {
            return Err("vault_paused".into());
        }
        let Some(agent) = self.agents.get(agent_id) else {
            return Err("unknown_agent".into());
        };
        if !agent.active {
            return Err("agent_disabled".into());
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
        if !self.allowlist.contains(recipient) {
            return Err("recipient_not_allowlisted".into());
        }
        if env::block_timestamp_ms() < self.payable_from(recipient) {
            return Err("recipient_in_cooldown".into());
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
        Ok(())
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
        self.requests.insert(req.key.clone(), req);
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
    }

    fn release(&mut self, req: &PaymentRequest) {
        if let Some(mut l) = self.get_limits(&req.agent, &req.token) {
            l.reserved = U128(l.reserved.0 - req.amount.0);
            self.put_limits(&req.agent, &req.token, l);
        }
        let mut p = self.pool(&req.token);
        p.reserved -= req.amount.0;
        self.put_pool(&req.token, p);
    }
}

#[cfg(test)]
mod tests;
