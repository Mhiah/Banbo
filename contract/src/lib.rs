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
//! Core invariant, per agent and for the shared treasury, in the current period:
//!     spent + reserved <= limit
//! and every request id settles at most once.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

/// Gas reserved for the payout callback.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Balance always kept back for storage and gas, never spendable by agents.
const OPERATING_RESERVE: NearToken = NearToken::from_millinear(500);
const MAX_MEMO_LEN: usize = 256;
const MAX_REQUEST_ID_LEN: usize = 64;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    Allowlist,
    Requests,
    RequestOrder,
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
    pub memo: String,
    pub status: Status,
    pub period_index: u64,
    pub created_at_ms: u64,
}

/// What `request_payment` tells the agent. Rejections are returned (and logged
/// as events) instead of panicking so an agent gets a clear, machine-readable
/// reason, and nothing is written to storage for them.
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
}

fn event(kind: &str, data: String) {
    log!(
        "EVENT_JSON:{{\"standard\":\"banbo\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        kind,
        data
    );
}

fn esc(s: &str) -> String {
    near_sdk::serde_json::to_string(s).unwrap()
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
        require!(amount.0 <= self.available(), "amount exceeds available balance");
        event("withdraw", format!("{{\"amount\":\"{}\"}}", amount.0));
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
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

    pub fn allow_recipient(&mut self, recipient: AccountId) {
        self.assert_owner();
        self.allowlist.insert(recipient.clone());
        event("recipient_allowed", format!("{{\"recipient\":{}}}", esc(recipient.as_str())));
    }

    pub fn disallow_recipient(&mut self, recipient: AccountId) {
        self.assert_owner();
        self.allowlist.remove(&recipient);
        event("recipient_removed", format!("{{\"recipient\":{}}}", esc(recipient.as_str())));
    }

    pub fn set_shared_cap(&mut self, shared_cap: U128) {
        self.assert_owner();
        self.shared_cap = shared_cap.0;
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
        self.pending_total -= req.amount.0;
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
        self.pending_total -= req.amount.0;
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

        if let Err(reason) = self.check_policy(&agent_id, &recipient, amount.0) {
            event(
                "payment_rejected",
                format!(
                    "{{\"agent\":{},\"request_id\":{},\"recipient\":{},\"amount\":\"{}\",\"reason\":{},\"memo\":{}}}",
                    esc(agent_id.as_str()),
                    esc(&request_id),
                    esc(recipient.as_str()),
                    amount.0,
                    esc(&reason),
                    esc(&memo)
                ),
            );
            return RequestOutcome::Rejected { reason };
        }

        // Reserve against agent + shared budgets before anything leaves.
        let period = self.current_period();
        {
            let a = self.agents.get_mut(&agent_id).unwrap();
            a.reserved = U128(a.reserved.0 + amount.0);
        }
        self.shared_reserved += amount.0;

        let needs_approval = amount.0 > self.agents.get(&agent_id).unwrap().approval_threshold.0;
        let req = PaymentRequest {
            key: key.clone(),
            agent: agent_id.clone(),
            request_id: request_id.clone(),
            recipient: recipient.clone(),
            amount,
            memo: memo.clone(),
            status: if needs_approval { Status::PendingApproval } else { Status::InFlight },
            period_index: period,
            created_at_ms: env::block_timestamp_ms(),
        };
        self.requests.insert(key.clone(), req.clone());
        self.request_order.push(key.clone());

        let data = format!(
            "{{\"key\":{},\"agent\":{},\"recipient\":{},\"amount\":\"{}\",\"memo\":{}}}",
            esc(&key),
            esc(agent_id.as_str()),
            esc(recipient.as_str()),
            amount.0,
            esc(&memo)
        );
        if needs_approval {
            self.pending_total += amount.0;
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

    /// Result of a transfer. Settles or releases the reservation exactly once.
    #[private]
    pub fn on_payout(&mut self, key: String, #[callback_result] result: Result<(), PromiseError>) -> bool {
        let mut req = self.requests.get(&key).cloned().unwrap_or_else(|| env::panic_str("unknown request"));
        // Exactly-once: only an InFlight request can be reconciled.
        require!(req.status == Status::InFlight, "request already reconciled");
        self.in_flight_total -= req.amount.0;
        let ok = result.is_ok();
        if ok {
            self.settle(&req);
            req.status = Status::Settled;
            event("payment_settled", format!("{{\"key\":{},\"amount\":\"{}\"}}", esc(&key), req.amount.0));
        } else {
            // The transfer's deposit is refunded to this account by the protocol.
            self.release(&req);
            req.status = Status::Failed;
            event("payment_failed", format!("{{\"key\":{},\"amount\":\"{}\"}}", esc(&key), req.amount.0));
        }
        self.requests.insert(key, req);
        ok
    }

    // ------------------------------------------------------------------ views

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            paused: self.paused,
            period_ms: self.period_ms,
            shared_cap: U128(self.shared_cap),
            current_period: self.current_period(),
        }
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

    pub fn get_balances(&self) -> Balances {
        let (spent, reserved) = self.rolled_shared();
        Balances {
            vault_balance: U128(env::account_balance().as_yoctonear()),
            operating_reserve: U128(OPERATING_RESERVE.as_yoctonear()),
            storage_cost: U128(self.storage_cost()),
            pending_approval: U128(self.pending_total),
            in_flight: U128(self.in_flight_total),
            available: U128(self.available()),
            shared_spent: U128(spent),
            shared_reserved: U128(reserved),
            shared_cap: U128(self.shared_cap),
        }
    }

    // --------------------------------------------------------------- internal

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn current_period(&self) -> u64 {
        env::block_timestamp_ms() / self.period_ms
    }

    fn storage_cost(&self) -> u128 {
        env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128
    }

    /// Spendable now: balance minus storage, operating reserve, and money
    /// already promised to pending approvals. In-flight transfers have
    /// already left the balance.
    fn available(&self) -> u128 {
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(self.storage_cost())
            .saturating_sub(OPERATING_RESERVE.as_yoctonear())
            .saturating_sub(self.pending_total)
    }

    /// When a new period starts, spent resets but outstanding reservations
    /// carry over (they are still promised money), which keeps the
    /// invariant conservative.
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

    fn roll(&mut self, agent_id: &AccountId) {
        let p = self.current_period();
        if self.shared_period != p {
            self.shared_period = p;
            self.shared_spent = 0;
        }
        if let Some(a) = self.agents.get(agent_id) {
            let rolled = self.rolled_agent(a);
            self.agents.insert(agent_id.clone(), rolled);
        }
    }

    fn check_policy(&mut self, agent_id: &AccountId, recipient: &AccountId, amount: u128) -> Result<(), String> {
        if self.paused {
            return Err("vault_paused".into());
        }
        if !self.agents.contains_key(agent_id) {
            return Err("unknown_agent".into());
        }
        self.roll(agent_id);
        let a = self.agents.get(agent_id).unwrap();
        if !a.active {
            return Err("agent_disabled".into());
        }
        if amount == 0 {
            return Err("zero_amount".into());
        }
        if recipient == &env::current_account_id() || recipient == agent_id {
            return Err("recipient_not_allowed".into());
        }
        if !self.allowlist.contains(recipient) {
            return Err("recipient_not_allowlisted".into());
        }
        if amount > a.per_tx_max.0 {
            return Err("exceeds_per_request_max".into());
        }
        if a.spent.0 + a.reserved.0 + amount > a.period_limit.0 {
            return Err("exceeds_agent_period_limit".into());
        }
        if self.shared_spent + self.shared_reserved + amount > self.shared_cap {
            return Err("exceeds_shared_cap".into());
        }
        if amount > self.available() {
            return Err("insufficient_vault_balance".into());
        }
        Ok(())
    }

    fn dispatch(&mut self, req: &PaymentRequest) -> Promise {
        self.in_flight_total += req.amount.0;
        event(
            "payment_dispatched",
            format!("{{\"key\":{},\"recipient\":{},\"amount\":\"{}\"}}", esc(&req.key), esc(req.recipient.as_str()), req.amount.0),
        );
        Promise::new(req.recipient.clone())
            .transfer(NearToken::from_yoctonear(req.amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_payout(req.key.clone()),
            )
    }

    /// Move a reservation to spent (only counts toward spent if it is still
    /// the period it was reserved in).
    fn settle(&mut self, req: &PaymentRequest) {
        self.roll(&req.agent);
        let p = self.current_period();
        if let Some(a) = self.agents.get_mut(&req.agent) {
            a.reserved = U128(a.reserved.0 - req.amount.0);
            if req.period_index == p {
                a.spent = U128(a.spent.0 + req.amount.0);
            }
        }
        self.shared_reserved -= req.amount.0;
        if req.period_index == p {
            self.shared_spent += req.amount.0;
        }
    }

    fn release(&mut self, req: &PaymentRequest) {
        if let Some(a) = self.agents.get_mut(&req.agent) {
            a.reserved = U128(a.reserved.0 - req.amount.0);
        }
        self.shared_reserved -= req.amount.0;
    }
}

#[cfg(test)]
mod tests;
