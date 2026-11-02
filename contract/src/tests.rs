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
    c.request_payment(id.into(), to, U128(yocto), None, None, None, None)
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
    assert!(c.list_requests(None, None).is_empty(), "rejections never become payment requests");
    let blocked = c.list_blocked(None);
    assert_eq!(blocked.len(), 2);
    assert_eq!(blocked[0].request_id, "inj-2"); // newest first
    assert_eq!(blocked[1].recipient, attacker());
    assert_eq!(blocked[1].reason, "recipient_not_allowlisted");
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
    let out = c.request_payment("x".into(), vendor(), U128(NEAR / 10), None, None, None, None);
    assert_eq!(out, RequestOutcome::Rejected { reason: "unknown_agent".into() });
}

#[test]
fn blocked_log_is_bounded_and_newest_first() {
    let mut c = setup();
    for i in 0..120 {
        pay(&mut c, 1, &format!("spam-{i}"), attacker(), NEAR);
    }
    let blocked = c.list_blocked(None);
    assert_eq!(blocked.len(), 50);
    assert_eq!(blocked[0].request_id, "spam-119");
    assert_eq!(blocked[49].request_id, "spam-70");
    assert_eq!(c.blocked_count(), 120);
    assert_eq!(c.list_blocked(Some(3)).len(), 3);
}

#[test]
fn unknown_callers_are_not_logged() {
    let mut c = setup();
    ctx(attacker(), 10, 2_000);
    c.request_payment("x".into(), vendor(), U128(NEAR / 10), None, None, None, None);
    assert_eq!(c.blocked_count(), 0);
}

#[test]
fn long_memos_are_truncated_in_the_log() {
    let mut c = setup();
    ctx(agent(1), 10, 2_000);
    let memo = "é".repeat(100); // 200 bytes, multi-byte chars
    c.request_payment("m".into(), attacker(), U128(NEAR), Some(memo), None, None, None);
    let b = &c.list_blocked(None)[0];
    assert!(b.memo.len() <= 80);
    assert!(b.memo.chars().all(|ch| ch == 'é'));
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
    assert!(c.on_payout(key.clone()));
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
    assert!(!c.on_payout(key.clone()));
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
    c.on_payout(key.clone());
    callback_ctx(false, 10, 3_001);
    c.on_payout(key);
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
    c.on_payout(key.clone());
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
    let out = c.request_payment("big".into(), vendor(), U128(6 * NEAR / 10), None, None, None, None);
    assert_eq!(out, RequestOutcome::Rejected { reason: "insufficient_vault_balance".into() });
}

#[test]
fn budget_resets_next_period_but_in_flight_carries_over() {
    let mut c = setup();
    for i in 0..5 {
        let RequestOutcome::Dispatched { key } = pay(&mut c, 1, &format!("d1-{i}"), vendor(), NEAR / 2) else { panic!() };
        callback_ctx(true, 10, 3_000);
        c.on_payout(key);
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
    c.on_payout(key);
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

// ------------------------------------------------------------- NEP-141 tokens

const USDC: u128 = 1_000_000; // 6 decimals

fn usdc() -> AccountId {
    "usdc.testnet".parse().unwrap()
}

fn cb(result: PromiseResult) {
    let c = VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(vault())
        .account_balance(NearToken::from_yoctonear(10 * NEAR))
        .block_timestamp(3_000 * 1_000_000)
        .build();
    testing_env!(c, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

/// setup() plus USDC: 100 USDC shared cap, 500 USDC deposited, agent1 may
/// pay up to 20 USDC each, 50 a day, approval above 15.
fn setup_usdc() -> Banbo {
    let mut c = setup();
    ctx(owner(), 10, 1_000);
    c.add_token(usdc(), "USDC".into(), 6, U128(100 * USDC));
    c.set_agent_token_limits(agent(1), usdc(), U128(20 * USDC), U128(50 * USDC), U128(15 * USDC));
    ctx(usdc(), 10, 1_000);
    let refund = c.ft_on_transfer(owner(), U128(500 * USDC), String::new());
    assert!(matches!(refund, PromiseOrValue::Value(U128(0))));
    c
}

fn pay_usdc(c: &mut Banbo, n: u8, id: &str, to: AccountId, amount: u128) -> RequestOutcome {
    ctx(agent(n), 10, 2_000);
    c.request_payment(id.into(), to, U128(amount), None, Some(usdc()), None, None)
}

fn token(c: &Banbo) -> TokenView {
    c.list_tokens().into_iter().find(|t| t.token == usdc()).unwrap()
}

fn usdc_limits(c: &Banbo, n: u8) -> Limits {
    c.get_agent_token_limits(agent(n)).into_iter().find(|(t, _)| *t == usdc()).unwrap().1
}

#[test]
fn deposits_only_count_from_added_tokens() {
    let mut c = setup_usdc();
    assert_eq!(token(&c).balance.0, 500 * USDC);
    let other: AccountId = "scam-token.testnet".parse().unwrap();
    ctx(other, 10, 1_000);
    let refund = c.ft_on_transfer(owner(), U128(7), String::new());
    assert!(matches!(refund, PromiseOrValue::Value(U128(7))), "unknown token must be refunded");
    assert_eq!(c.list_tokens().len(), 1);
}

#[test]
fn token_payment_needs_supported_token_and_agent_limits() {
    let mut c = setup_usdc();
    ctx(agent(1), 10, 2_000);
    let out = c.request_payment("t0".into(), vendor(), U128(USDC), None, Some("other.testnet".parse().unwrap()), None, None);
    assert_eq!(out, RequestOutcome::Rejected { reason: "token_not_supported".into() });
    let out = pay_usdc(&mut c, 2, "t1", vendor(), USDC);
    assert_eq!(out, RequestOutcome::Rejected { reason: "token_not_enabled_for_agent".into() });
    let out = pay_usdc(&mut c, 1, "t2", attacker(), USDC);
    assert_eq!(out, RequestOutcome::Rejected { reason: "recipient_not_allowlisted".into() });
    let out = pay_usdc(&mut c, 1, "t3", vendor(), 21 * USDC);
    assert_eq!(out, RequestOutcome::Rejected { reason: "exceeds_per_request_max".into() });
    assert_eq!(c.list_blocked(None)[0].token, Some(usdc()));
}

#[test]
fn token_payment_settles_after_registration_check() {
    let mut c = setup_usdc();
    let out = pay_usdc(&mut c, 1, "inv-1", vendor(), 12 * USDC);
    let key = format!("{}:inv-1", agent(1));
    assert_eq!(out, RequestOutcome::Dispatched { key: key.clone() });
    let t = token(&c);
    assert_eq!(t.balance.0, 488 * USDC, "in-flight tokens leave the tracked balance");
    assert_eq!(t.in_flight.0, 12 * USDC);
    assert_eq!(usdc_limits(&c, 1).reserved.0, 12 * USDC);

    cb(PromiseResult::Successful(br#"{"total":"1250000000000000000000","available":"0"}"#.to_vec()));
    assert!(matches!(c.on_recipient_checked(key.clone()), PromiseOrValue::Promise(_)));
    assert_eq!(c.get_request(key.clone()).unwrap().status, Status::InFlight);

    cb(PromiseResult::Successful(vec![]));
    assert!(c.on_payout(key.clone()));
    let r = c.get_request(key).unwrap();
    assert_eq!(r.status, Status::Settled);
    assert_eq!(r.token, Some(usdc()));
    let t = token(&c);
    assert_eq!((t.balance.0, t.in_flight.0, t.shared_spent.0, t.shared_reserved.0), (488 * USDC, 0, 12 * USDC, 0));
    let l = usdc_limits(&c, 1);
    assert_eq!((l.spent.0, l.reserved.0), (12 * USDC, 0));
    // NEAR budgets are untouched by token spending.
    let b = c.get_balances();
    assert_eq!((b.shared_spent.0, b.shared_reserved.0), (0, 0));
}

#[test]
fn unregistered_recipient_fails_and_restores_everything() {
    let mut c = setup_usdc();
    pay_usdc(&mut c, 1, "inv-2", vendor(), 10 * USDC);
    let key = format!("{}:inv-2", agent(1));
    cb(PromiseResult::Successful(b"null".to_vec()));
    assert!(matches!(c.on_recipient_checked(key.clone()), PromiseOrValue::Value(false)));
    let r = c.get_request(key.clone()).unwrap();
    assert_eq!(r.status, Status::Failed);
    assert_eq!(r.failure_reason.as_deref(), Some("recipient_not_registered"));
    let t = token(&c);
    assert_eq!((t.balance.0, t.in_flight.0, t.shared_reserved.0), (500 * USDC, 0, 0));
    assert_eq!(usdc_limits(&c, 1).reserved.0, 0);
    // Exactly once: a second callback can't run.
    cb(PromiseResult::Successful(vec![]));
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.on_payout(key)));
    assert!(again.is_err());
}

#[test]
fn failed_ft_transfer_restores_balance_and_budget() {
    let mut c = setup_usdc();
    pay_usdc(&mut c, 1, "inv-3", vendor(), 5 * USDC);
    let key = format!("{}:inv-3", agent(1));
    cb(PromiseResult::Successful(br#"{"total":"1","available":"0"}"#.to_vec()));
    let _ = c.on_recipient_checked(key.clone());
    cb(PromiseResult::Failed);
    assert!(!c.on_payout(key.clone()));
    let r = c.get_request(key).unwrap();
    assert_eq!((r.status, r.failure_reason.as_deref()), (Status::Failed, Some("transfer_failed")));
    let t = token(&c);
    assert_eq!((t.balance.0, t.in_flight.0, t.shared_spent.0, t.shared_reserved.0), (500 * USDC, 0, 0, 0));
}

#[test]
fn a_failing_registration_check_counts_as_not_registered() {
    let mut c = setup_usdc();
    pay_usdc(&mut c, 1, "inv-4", vendor(), USDC);
    let key = format!("{}:inv-4", agent(1));
    cb(PromiseResult::Failed);
    assert!(matches!(c.on_recipient_checked(key.clone()), PromiseOrValue::Value(false)));
    assert_eq!(token(&c).balance.0, 500 * USDC);
}

#[test]
fn token_limits_and_balance_are_enforced() {
    let mut c = setup_usdc();
    for i in 0..2 {
        assert!(matches!(pay_usdc(&mut c, 1, &format!("a{i}"), vendor(), 15 * USDC), RequestOutcome::Dispatched { .. }));
    }
    // 30 reserved; another 15 is fine (45), then 10 more breaks the 50 daily limit.
    assert!(matches!(pay_usdc(&mut c, 1, "a2", vendor(), 15 * USDC), RequestOutcome::Dispatched { .. }));
    assert_eq!(pay_usdc(&mut c, 1, "a3", vendor(), 10 * USDC), RequestOutcome::Rejected { reason: "exceeds_agent_period_limit".into() });

    // Balance: a fresh vault with only 3 USDC.
    let mut c = setup();
    ctx(owner(), 10, 1_000);
    c.add_token(usdc(), "USDC".into(), 6, U128(100 * USDC));
    c.set_agent_token_limits(agent(1), usdc(), U128(20 * USDC), U128(50 * USDC), U128(15 * USDC));
    ctx(usdc(), 10, 1_000);
    let _ = c.ft_on_transfer(owner(), U128(3 * USDC), String::new());
    assert_eq!(pay_usdc(&mut c, 1, "b", vendor(), 4 * USDC), RequestOutcome::Rejected { reason: "insufficient_vault_balance".into() });
}

#[test]
fn token_approval_holds_funds_until_decided() {
    let mut c = setup_usdc();
    let out = pay_usdc(&mut c, 1, "big", vendor(), 18 * USDC);
    let key = format!("{}:big", agent(1));
    assert_eq!(out, RequestOutcome::PendingApproval { key: key.clone() });
    let t = token(&c);
    assert_eq!((t.balance.0, t.pending_approval.0, t.available.0), (500 * USDC, 18 * USDC, 482 * USDC));
    ctx(owner(), 10, 2_500);
    c.decline(key.clone());
    let t = token(&c);
    assert_eq!((t.pending_approval.0, t.available.0, t.shared_reserved.0), (0, 500 * USDC, 0));
    assert_eq!(usdc_limits(&c, 1).reserved.0, 0);
}

#[test]
fn owner_token_withdrawal_is_bounded_and_restored_on_failure() {
    let mut c = setup_usdc();
    pay_usdc(&mut c, 1, "big", vendor(), 18 * USDC); // held for approval
    ctx(owner(), 10, 2_500);
    let too_much = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut c2 = setup_usdc();
        pay_usdc(&mut c2, 1, "big", vendor(), 18 * USDC);
        ctx(owner(), 10, 2_500);
        let _ = c2.withdraw_token(usdc(), U128(483 * USDC));
    }));
    assert!(too_much.is_err(), "can't withdraw funds promised to a pending approval");
    let _ = c.withdraw_token(usdc(), U128(100 * USDC));
    assert_eq!(token(&c).balance.0, 400 * USDC);
    cb(PromiseResult::Failed);
    assert!(!c.on_token_withdraw(usdc(), U128(100 * USDC)));
    assert_eq!(token(&c).balance.0, 500 * USDC);
}

#[test]
fn only_owner_configures_tokens() {
    let mut c = setup();
    ctx(agent(1), 10, 1_000);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.add_token(usdc(), "USDC".into(), 6, U128(1))));
    assert!(r.is_err());
}

// ------------------------------------------------------------ risk rules

fn pay_at(c: &mut Banbo, n: u8, id: &str, to: AccountId, yocto: u128, ts: u64) -> RequestOutcome {
    ctx(agent(n), 10, ts);
    c.request_payment(id.into(), to, U128(yocto), None, None, None, None)
}

fn newcomer() -> AccountId {
    "new-vendor.testnet".parse().unwrap()
}

#[test]
fn newly_allowed_recipient_waits_out_the_cooldown() {
    let mut c = setup(); // vendor allowed at t=1s, before any cooldown
    ctx(owner(), 10, 1_000);
    c.set_risk_rules(60_000, 0);
    ctx(owner(), 10, 100_000);
    c.allow_recipient(newcomer());
    let r = c.list_recipients().into_iter().find(|r| r.account == newcomer()).unwrap();
    assert_eq!((r.added_at_ms, r.payable_from_ms), (100_000, 160_000));

    assert_eq!(pay_at(&mut c, 1, "a", newcomer(), NEAR / 10, 159_999), RequestOutcome::Rejected { reason: "recipient_in_cooldown".into() });
    assert_eq!(c.list_blocked(None)[0].reason, "recipient_in_cooldown");
    // The long-standing vendor is past its cooldown.
    assert!(matches!(pay_at(&mut c, 1, "b", vendor(), NEAR / 10, 159_999), RequestOutcome::Dispatched { .. }));
    assert!(matches!(pay_at(&mut c, 1, "c", newcomer(), NEAR / 10, 160_000), RequestOutcome::Dispatched { .. }));
}

#[test]
fn re_allowing_keeps_the_clock_but_removing_resets_it() {
    let mut c = setup();
    ctx(owner(), 10, 1_000);
    c.set_risk_rules(60_000, 0);
    c.allow_recipient(newcomer());
    ctx(owner(), 10, 50_000);
    c.allow_recipient(newcomer()); // no-op for the clock
    assert!(matches!(pay_at(&mut c, 1, "a", newcomer(), NEAR / 10, 61_000), RequestOutcome::Dispatched { .. }));
    ctx(owner(), 10, 70_000);
    c.disallow_recipient(newcomer());
    c.allow_recipient(newcomer());
    assert_eq!(pay_at(&mut c, 1, "b", newcomer(), NEAR / 10, 80_000), RequestOutcome::Rejected { reason: "recipient_in_cooldown".into() });
}

#[test]
fn cooldown_off_by_default() {
    let mut c = setup();
    ctx(owner(), 10, 1_000);
    c.allow_recipient(newcomer());
    assert!(matches!(pay_at(&mut c, 1, "a", newcomer(), NEAR / 10, 1_001), RequestOutcome::Dispatched { .. }));
    assert_eq!(c.get_config().recipient_cooldown_ms, 0);
}

#[test]
fn payment_rate_stops_slow_drip() {
    let mut c = setup();
    ctx(owner(), 10, 1_000);
    c.set_risk_rules(0, 3);
    let tiny = NEAR / 100;
    for i in 0..3 {
        assert!(matches!(pay_at(&mut c, 1, &format!("d{i}"), vendor(), tiny, 2_000 + i), RequestOutcome::Dispatched { .. }));
    }
    assert_eq!(pay_at(&mut c, 1, "d3", vendor(), tiny, 3_000), RequestOutcome::Rejected { reason: "exceeds_payment_rate".into() });
    // Rejections don't use up the allowance; other agents have their own.
    assert_eq!(c.get_agent_rate(agent(1)).count, 3);
    assert!(matches!(pay_at(&mut c, 2, "e0", vendor(), tiny, 3_000), RequestOutcome::Dispatched { .. }));
    // A new hour starts a new window.
    assert!(matches!(pay_at(&mut c, 1, "d4", vendor(), tiny, 2_000 + 3_600_000), RequestOutcome::Dispatched { .. }));
    assert_eq!(c.get_agent_rate(agent(1)).count, 1);
}

#[test]
fn duplicates_and_blocked_attempts_do_not_count_toward_the_rate() {
    let mut c = setup();
    ctx(owner(), 10, 1_000);
    c.set_risk_rules(0, 2);
    pay_at(&mut c, 1, "x", vendor(), NEAR / 100, 2_000);
    pay_at(&mut c, 1, "x", vendor(), NEAR / 100, 2_001); // duplicate
    pay_at(&mut c, 1, "y", attacker(), NEAR / 100, 2_002); // blocked
    assert_eq!(c.get_agent_rate(agent(1)).count, 1);
    assert!(matches!(pay_at(&mut c, 1, "z", vendor(), NEAR / 100, 2_003), RequestOutcome::Dispatched { .. }));
}

#[test]
fn only_owner_sets_risk_rules() {
    let mut c = setup();
    ctx(agent(1), 10, 1_000);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_risk_rules(0, 0)));
    assert!(r.is_err());
}

#[test]
fn cooldown_applies_to_recipients_added_under_it_and_lowering_releases() {
    let mut c = setup(); // vendor added with no cooldown
    ctx(owner(), 10, 1_000);
    c.set_risk_rules(3_600_000, 0);
    assert!(matches!(pay_at(&mut c, 1, "v", vendor(), NEAR / 10, 2_000), RequestOutcome::Dispatched { .. }));
    ctx(owner(), 10, 2_000);
    c.allow_recipient(newcomer());
    assert_eq!(pay_at(&mut c, 1, "n1", newcomer(), NEAR / 10, 10_000), RequestOutcome::Rejected { reason: "recipient_in_cooldown".into() });
    // Owner checks the newcomer and lowers the cooldown to 5 s: it is now payable.
    ctx(owner(), 10, 10_000);
    c.set_risk_rules(5_000, 0);
    assert!(matches!(pay_at(&mut c, 1, "n2", newcomer(), NEAR / 10, 10_000), RequestOutcome::Dispatched { .. }));
}
