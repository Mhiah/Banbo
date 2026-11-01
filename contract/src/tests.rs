use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const NEAR: u128 = 10u128.pow(24);
const DAY_MS: u64 = 86_400_000;

fn owner() -> AccountId {
    "owner.testnet".parse().unwrap()
}
fn vault() -> AccountId {
    "vault.testnet".parse().unwrap()
}
fn agent(n: u8) -> AccountId {
    format!("agent{n}.testnet").parse().unwrap()
}
fn vendor() -> AccountId {
    "api-vendor.testnet".parse().unwrap()
}
fn attacker() -> AccountId {
    "attacker.testnet".parse().unwrap()
}

fn ctx(caller: AccountId, balance_near: u128, ts_ms: u64) {
    let c = VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(caller)
        .account_balance(NearToken::from_yoctonear(balance_near * NEAR))
        .block_timestamp(ts_ms * 1_000_000)
        .build();
    testing_env!(c);
}

fn callback_ctx(ok: bool, balance_near: u128, ts_ms: u64) {
    let c = VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(vault())
        .account_balance(NearToken::from_yoctonear(balance_near * NEAR))
        .block_timestamp(ts_ms * 1_000_000)
        .build();
    let r = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    testing_env!(c, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![r]);
}

/// 10 NEAR vault, 5 NEAR shared daily cap, three agents with
/// 0.5 NEAR per request, 3 NEAR per agent per day, approval above 0.4 NEAR
/// for agent3 (others never need approval at their max).
fn setup() -> Banbo {
    ctx(owner(), 10, 1_000);
    let mut c = Banbo::new(owner(), DAY_MS, U128(5 * NEAR));
    for n in 1..=3 {
        let threshold = if n == 3 { 4 * NEAR / 10 } else { NEAR };
        c.add_agent(agent(n), U128(NEAR / 2), U128(3 * NEAR), U128(threshold));
    }
    c.allow_recipient(vendor());
    c
}

fn pay(c: &mut Banbo, n: u8, id: &str, to: AccountId, yocto: u128) -> RequestOutcome {
    ctx(agent(n), 10, 2_000);
    c.request_payment(id.into(), to, U128(yocto), None)
}

fn assert_invariant(c: &Banbo) {
    let b = c.get_balances();
    assert!(b.shared_spent.0 + b.shared_reserved.0 <= b.shared_cap.0, "shared invariant broken");
    for (_, a) in c.list_agents() {
        assert!(a.spent.0 + a.reserved.0 <= a.period_limit.0, "agent invariant broken");
    }
}

// ------------------------------------------------------- prompt injection

#[test]
fn injected_drain_to_attacker_is_rejected_and_nothing_moves() {
    let mut c = setup();
    let out = pay(&mut c, 1, "inj-1", attacker(), 9 * NEAR);
    assert_eq!(out, RequestOutcome::Rejected { reason: "recipient_not_allowlisted".into() });
    // Even a small amount to the attacker is refused.
    let out = pay(&mut c, 1, "inj-2", attacker(), NEAR / 100);
    assert_eq!(out, RequestOutcome::Rejected { reason: "recipient_not_allowlisted".into() });
    assert!(c.list_requests(None, None).is_empty(), "rejections must not write storage");
    let b = c.get_balances();
    assert_eq!(b.shared_reserved.0, 0);
    assert_eq!(b.in_flight.0, 0);
    assert!(get_logs().iter().any(|l| l.contains("payment_rejected") && l.contains("attacker.testnet")));
}

#[test]
fn injected_drain_to_allowlisted_vendor_is_capped() {
    let mut c = setup();
    // Agent is tricked into "prepaying" the vendor everything.
    let out = pay(&mut c, 1, "inj-3", vendor(), 9 * NEAR);
    assert_eq!(out, RequestOutcome::Rejected { reason: "exceeds_per_request_max".into() });
    // Splitting into many small payments hits the agent's daily limit.
    let mut dispatched = 0;
    for i in 0..20 {
        match pay(&mut c, 1, &format!("split-{i}"), vendor(), NEAR / 2) {
            RequestOutcome::Dispatched { .. } => dispatched += 1,
            RequestOutcome::Rejected { reason } => assert_eq!(reason, "exceeds_agent_period_limit"),
            o => panic!("unexpected {o:?}"),
        }
    }
    assert_eq!(dispatched, 6); // 3 NEAR / 0.5
    assert_invariant(&c);
}

#[test]
fn unknown_caller_cannot_spend() {
    let mut c = setup();
    ctx(attacker(), 10, 2_000);
    let out = c.request_payment("x".into(), vendor(), U128(NEAR / 10), None);
    assert_eq!(out, RequestOutcome::Rejected { reason: "unknown_agent".into() });
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_allowlist_attacker() {
    let mut c = setup();
    ctx(agent(1), 10, 2_000);
    c.allow_recipient(attacker());
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_withdraw() {
    let mut c = setup();
    ctx(agent(1), 10, 2_000);
    let _ = c.withdraw(U128(NEAR));
}

#[test]
fn agent_cannot_pay_itself_or_vault() {
    let mut c = setup();
    ctx(owner(), 10, 1_500);
    c.allow_recipient(agent(1));
    let out = pay(&mut c, 1, "self", agent(1), NEAR / 10);
    assert_eq!(out, RequestOutcome::Rejected { reason: "recipient_not_allowed".into() });
}

// ------------------------------------------------------------ shared cap

#[test]
fn shared_cap_holds_across_agents() {
    let mut c = setup();
    let mut ok = 0;
    // 20 requests of 0.5 NEAR spread over 3 agents; 5 NEAR cap => 10 max.
    for i in 0..20u8 {
        let n = (i % 3) + 1;
        let id = format!("r{i}");
        match pay(&mut c, n, &id, vendor(), NEAR / 2) {
            RequestOutcome::Dispatched { .. } | RequestOutcome::PendingApproval { .. } => ok += 1,
            RequestOutcome::Rejected { .. } => {}
            o => panic!("unexpected {o:?}"),
        }
        assert_invariant(&c);
    }
    assert_eq!(ok, 10);
    assert_eq!(c.get_balances().shared_reserved.0, 5 * NEAR);
}

// ----------------------------------------------------- async reconciliation

#[test]
fn successful_payout_moves_reserved_to_spent() {
    let mut c = setup();
    let RequestOutcome::Dispatched { key } = pay(&mut c, 1, "ok-1", vendor(), NEAR / 2) else { panic!() };
    assert_eq!(c.get_balances().in_flight.0, NEAR / 2);
    callback_ctx(true, 10, 3_000);
    assert!(c.on_payout(key.clone(), Ok(())));
    let a = c.get_agent(agent(1)).unwrap();
    assert_eq!(a.spent.0, NEAR / 2);
    assert_eq!(a.reserved.0, 0);
    assert_eq!(c.get_request(key).unwrap().status, Status::Settled);
    assert_eq!(c.get_balances().in_flight.0, 0);
    assert_invariant(&c);
}

#[test]
fn failed_payout_releases_budget_exactly_once() {
    let mut c = setup();
    let ghost: AccountId = "does-not-exist-xyz.testnet".parse().unwrap();
    ctx(owner(), 10, 1_500);
    c.allow_recipient(ghost.clone());
    let RequestOutcome::Dispatched { key } = pay(&mut c, 1, "fail-1", ghost, NEAR / 2) else { panic!() };

    // Other requests keep arriving while the transfer is in flight.
    let RequestOutcome::Dispatched { .. } = pay(&mut c, 2, "during-1", vendor(), NEAR / 2) else { panic!() };
    assert_eq!(c.get_balances().shared_reserved.0, NEAR);

    callback_ctx(false, 10, 3_000);
    assert!(!c.on_payout(key.clone(), Err(PromiseError::Failed)));
    let a = c.get_agent(agent(1)).unwrap();
    assert_eq!(a.reserved.0, 0);
    assert_eq!(a.spent.0, 0);
    assert_eq!(c.get_request(key.clone()).unwrap().status, Status::Failed);
    assert_eq!(c.get_balances().shared_reserved.0, NEAR / 2);
    assert_invariant(&c);
}

#[test]
#[should_panic(expected = "request already reconciled")]
fn callback_cannot_run_twice() {
    let mut c = setup();
    let RequestOutcome::Dispatched { key } = pay(&mut c, 1, "twice", vendor(), NEAR / 2) else { panic!() };
    callback_ctx(false, 10, 3_000);
    c.on_payout(key.clone(), Err(PromiseError::Failed));
    callback_ctx(false, 10, 3_001);
    c.on_payout(key, Err(PromiseError::Failed));
}

// `#[private]` on on_payout is enforced by the generated wasm entry point,
// not in unit tests; see the sandbox integration tests.

#[test]
fn retried_request_id_never_pays_twice() {
    let mut c = setup();
    let RequestOutcome::Dispatched { key } = pay(&mut c, 1, "retry", vendor(), NEAR / 2) else { panic!() };
    let again = pay(&mut c, 1, "retry", vendor(), NEAR / 2);
    assert_eq!(again, RequestOutcome::Duplicate { key: key.clone(), status: Status::InFlight });
    callback_ctx(false, 10, 3_000);
    c.on_payout(key.clone(), Err(PromiseError::Failed));
    // Retrying a failed id does not re-send; agent must use a new id.
    let again = pay(&mut c, 1, "retry", vendor(), NEAR / 2);
    assert_eq!(again, RequestOutcome::Duplicate { key, status: Status::Failed });
    assert_eq!(c.get_balances().in_flight.0, 0);
}

#[test]
fn same_request_id_from_different_agents_is_independent() {
    let mut c = setup();
    assert!(matches!(pay(&mut c, 1, "same", vendor(), NEAR / 10), RequestOutcome::Dispatched { .. }));
    assert!(matches!(pay(&mut c, 2, "same", vendor(), NEAR / 10), RequestOutcome::Dispatched { .. }));
}

// ---------------------------------------------------------- human approval

#[test]
fn over_threshold_waits_for_owner_then_dispatches() {
    let mut c = setup();
    let RequestOutcome::PendingApproval { key } = pay(&mut c, 3, "big", vendor(), NEAR / 2) else { panic!() };
    let b = c.get_balances();
    assert_eq!(b.pending_approval.0, NEAR / 2);
    assert_eq!(b.in_flight.0, 0);
    assert_eq!(b.shared_reserved.0, NEAR / 2);

    ctx(owner(), 10, 2_500);
    let _ = c.approve(key.clone());
    let b = c.get_balances();
    assert_eq!(b.pending_approval.0, 0);
    assert_eq!(b.in_flight.0, NEAR / 2);
    assert_eq!(c.get_request(key).unwrap().status, Status::InFlight);
}

#[test]
fn declined_request_releases_budget() {
    let mut c = setup();
    let RequestOutcome::PendingApproval { key } = pay(&mut c, 3, "big", vendor(), NEAR / 2) else { panic!() };
    ctx(owner(), 10, 2_500);
    c.decline(key.clone());
    assert_eq!(c.get_request(key).unwrap().status, Status::Declined);
    let b = c.get_balances();
    assert_eq!(b.pending_approval.0, 0);
    assert_eq!(b.shared_reserved.0, 0);
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_approve_its_own_request() {
    let mut c = setup();
    let RequestOutcome::PendingApproval { key } = pay(&mut c, 3, "big", vendor(), NEAR / 2) else { panic!() };
    ctx(agent(3), 10, 2_500);
    let _ = c.approve(key);
}

#[test]
#[should_panic(expected = "recipient no longer allowlisted")]
fn approval_rechecks_allowlist() {
    let mut c = setup();
    let RequestOutcome::PendingApproval { key } = pay(&mut c, 3, "big", vendor(), NEAR / 2) else { panic!() };
    ctx(owner(), 10, 2_500);
    c.disallow_recipient(vendor());
    let _ = c.approve(key);
}

// ------------------------------------------------------- controls & periods

#[test]
fn pause_and_disable_stop_new_payments() {
    let mut c = setup();
    ctx(owner(), 10, 1_500);
    c.set_agent_active(agent(1), false);
    assert_eq!(pay(&mut c, 1, "a", vendor(), NEAR / 10), RequestOutcome::Rejected { reason: "agent_disabled".into() });
    ctx(owner(), 10, 1_600);
    c.pause();
    assert_eq!(pay(&mut c, 2, "b", vendor(), NEAR / 10), RequestOutcome::Rejected { reason: "vault_paused".into() });
}

#[test]
fn vault_balance_is_respected() {
    // Vault holds only 1 NEAR, 0.5 of which is the operating reserve.
    ctx(owner(), 1, 1_000);
    let mut c = Banbo::new(owner(), DAY_MS, U128(5 * NEAR));
    c.add_agent(agent(1), U128(NEAR), U128(3 * NEAR), U128(NEAR));
    c.allow_recipient(vendor());
    ctx(agent(1), 1, 2_000);
    let out = c.request_payment("big".into(), vendor(), U128(6 * NEAR / 10), None);
    assert_eq!(out, RequestOutcome::Rejected { reason: "insufficient_vault_balance".into() });
}

#[test]
fn budget_resets_next_period_but_in_flight_carries_over() {
    let mut c = setup();
    for i in 0..5 {
        let RequestOutcome::Dispatched { key } = pay(&mut c, 1, &format!("d1-{i}"), vendor(), NEAR / 2) else { panic!() };
        callback_ctx(true, 10, 3_000);
        c.on_payout(key, Ok(()));
    }
    // One more in flight at the end of day 1.
    let RequestOutcome::Dispatched { key } = pay(&mut c, 1, "late", vendor(), NEAR / 2) else { panic!() };
    assert_eq!(pay(&mut c, 1, "over", vendor(), NEAR / 2), RequestOutcome::Rejected { reason: "exceeds_agent_period_limit".into() });

    // Next day: spent resets, the in-flight 0.5 still counts as reserved.
    ctx(agent(1), 10, 2_000 + DAY_MS);
    let a = c.get_agent(agent(1)).unwrap();
    assert_eq!(a.spent.0, 0);
    assert_eq!(a.reserved.0, NEAR / 2);
    // Callback lands on day 2: reservation clears, day-2 spend untouched.
    callback_ctx(true, 10, 3_000 + DAY_MS);
    c.on_payout(key, Ok(()));
    let a = c.get_agent(agent(1)).unwrap();
    assert_eq!(a.reserved.0, 0);
    assert_eq!(a.spent.0, 0);
    assert_invariant(&c);
}

#[test]
fn withdraw_cannot_touch_pending_approvals() {
    let mut c = setup();
    let RequestOutcome::PendingApproval { .. } = pay(&mut c, 3, "big", vendor(), NEAR / 2) else { panic!() };
    ctx(owner(), 10, 2_500);
    let avail = c.get_balances().available.0;
    assert!(avail <= 10 * NEAR - NEAR / 2 - NEAR / 2);
}
