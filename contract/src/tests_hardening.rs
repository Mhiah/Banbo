//! Phase 4 hardening: expiring approvals, stuck-payment recovery, agent
//! removal, two-step ownership transfer and bounded payment history.
use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const NEAR: u128 = 10u128.pow(24);
const USDC: u128 = 1_000_000;
const DAY_MS: u64 = 86_400_000;
const T0: u64 = 1_000_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acct("owner.testnet")
}
fn vault() -> AccountId {
    acct("vault.testnet")
}
fn agent() -> AccountId {
    acct("agent.testnet")
}
fn vendor() -> AccountId {
    acct("vendor.testnet")
}
fn usdc() -> AccountId {
    acct("usdc.testnet")
}

fn ctx(caller: AccountId, ts_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(caller)
        .account_balance(NearToken::from_near(100))
        .block_timestamp(ts_ms * 1_000_000)
        .build());
}

fn callback(ok: bool, ts_ms: u64) {
    let c = VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(vault())
        .account_balance(NearToken::from_near(100))
        .block_timestamp(ts_ms * 1_000_000)
        .build();
    let r = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    testing_env!(c, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![r]);
}

/// Agent may pay up to 1 NEAR each, 10 a day; above 0.5 NEAR needs approval.
fn setup() -> Banbo {
    ctx(owner(), T0);
    let mut c = Banbo::new(owner(), DAY_MS, U128(50 * NEAR));
    c.add_agent(agent(), U128(NEAR), U128(10 * NEAR), U128(NEAR / 2));
    c.allow_recipient(vendor());
    c
}

fn pay(c: &mut Banbo, id: &str, yocto: u128, ts_ms: u64) -> RequestOutcome {
    ctx(agent(), ts_ms);
    c.request_payment(id.into(), vendor(), U128(yocto), None, None, None)
}

fn key(id: &str) -> String {
    format!("{}:{}", agent(), id)
}

fn status(c: &Banbo, id: &str) -> Status {
    c.get_request(key(id)).unwrap().status
}

fn panics<F: FnOnce() -> R, R>(f: F) -> String {
    let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).err().expect("expected a panic");
    e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
}

// ------------------------------------------------------ expiring approvals

#[test]
fn pending_approval_records_its_deadline() {
    let mut c = setup();
    assert!(matches!(pay(&mut c, "big", 8 * NEAR / 10, T0), RequestOutcome::PendingApproval { .. }));
    let r = c.get_request(key("big")).unwrap();
    assert_eq!(r.expires_at_ms, Some(T0 + DEFAULT_APPROVAL_TTL_MS));
    assert_eq!(r.dispatched_at_ms, None);
    assert_eq!(c.list_open().len(), 1);
    assert_eq!(c.get_config().open_payments, 1);
}

#[test]
fn an_expired_approval_cannot_be_approved() {
    let mut c = setup();
    pay(&mut c, "big", 8 * NEAR / 10, T0);
    ctx(owner(), T0 + DEFAULT_APPROVAL_TTL_MS);
    assert!(panics(|| c.approve(key("big"))).contains("approval window has passed"));
    // One millisecond earlier it would have gone through.
    let mut c = setup();
    pay(&mut c, "big", 8 * NEAR / 10, T0);
    ctx(owner(), T0 + DEFAULT_APPROVAL_TTL_MS - 1);
    let _ = c.approve(key("big"));
    assert_eq!(status(&c, "big"), Status::InFlight);
    assert_eq!(c.get_request(key("big")).unwrap().dispatched_at_ms, Some(T0 + DEFAULT_APPROVAL_TTL_MS - 1));
}

#[test]
fn the_next_payment_request_releases_expired_approvals_on_its_own() {
    // A 1.6 NEAR daily budget: two parked approvals use all of it.
    let mut c = setup();
    ctx(owner(), T0);
    c.add_agent(agent(), U128(NEAR), U128(16 * NEAR / 10), U128(NEAR / 2));
    c.set_approval_ttl(3_600_000);
    pay(&mut c, "big-1", 8 * NEAR / 10, T0);
    pay(&mut c, "big-2", 8 * NEAR / 10, T0);
    assert_eq!(
        pay(&mut c, "small", NEAR / 10, T0 + 3_599_999),
        RequestOutcome::Rejected { reason: "exceeds_agent_period_limit".into() }
    );
    // Once nobody approved them in time, the next request releases both in
    // the same call and goes through.
    let out = pay(&mut c, "small", NEAR / 10, T0 + 3_600_000);
    assert!(matches!(out, RequestOutcome::Dispatched { .. }), "{out:?}");
    assert_eq!(status(&c, "big-1"), Status::Expired);
    assert_eq!(status(&c, "big-2"), Status::Expired);
    assert_eq!(get_logs().iter().filter(|l| l.contains("payment_expired")).count(), 2);
    assert_eq!(c.get_agent(agent()).unwrap().reserved.0, NEAR / 10, "only the new payment is reserved");
    assert_eq!(c.get_balances().pending_approval.0, 0);
    assert_eq!(c.list_open().len(), 1);
}

#[test]
fn a_new_approval_ttl_applies_to_new_requests_only() {
    let mut c = setup();
    pay(&mut c, "old", 8 * NEAR / 10, T0);
    ctx(owner(), T0);
    c.set_approval_ttl(3_600_000);
    pay(&mut c, "new", 8 * NEAR / 10, T0);
    assert_eq!(c.get_request(key("old")).unwrap().expires_at_ms, Some(T0 + DEFAULT_APPROVAL_TTL_MS));
    assert_eq!(c.get_request(key("new")).unwrap().expires_at_ms, Some(T0 + 3_600_000));
}

#[test]
fn anyone_can_expire_overdue_approvals_and_early_calls_do_nothing() {
    let mut c = setup();
    ctx(owner(), T0);
    c.set_approval_ttl(60_000);
    pay(&mut c, "a", 6 * NEAR / 10, T0);
    pay(&mut c, "b", 7 * NEAR / 10, T0 + 30_000);
    ctx(vendor(), T0 + 59_999);
    assert_eq!(c.expire_pending(None), 0);
    ctx(vendor(), T0 + 60_000);
    assert_eq!(c.expire_pending(None), 1);
    assert_eq!(status(&c, "a"), Status::Expired);
    assert_eq!(status(&c, "b"), Status::PendingApproval);
    ctx(vendor(), T0 + 90_000);
    assert_eq!(c.expire_pending(Some(5)), 1);
    assert_eq!(status(&c, "b"), Status::Expired);
    assert_eq!(c.get_agent(agent()).unwrap().reserved.0, 0);
    // An expired request can't be declined or approved afterwards.
    ctx(owner(), T0 + 90_000);
    assert!(panics(|| c.decline(key("a"))).contains("not pending approval"));
}

#[test]
fn the_sweep_respects_its_limit_and_finishes_later() {
    let mut c = setup();
    ctx(owner(), T0);
    c.set_approval_ttl(60_000);
    for i in 0..4 {
        pay(&mut c, &format!("p{i}"), 6 * NEAR / 10, T0);
    }
    ctx(vendor(), T0 + 60_000);
    assert_eq!(c.expire_pending(Some(3)), 3);
    assert_eq!(c.expire_pending(Some(3)), 1);
    assert_eq!(c.expire_pending(Some(3)), 0);
    assert_eq!(c.get_balances().pending_approval.0, 0);
}

#[test]
fn approval_ttl_is_bounded_and_owner_only() {
    let mut c = setup();
    ctx(owner(), T0);
    assert!(panics(|| c.set_approval_ttl(59_999)).contains("between 1 minute and 30 days"));
    assert!(panics(|| c.set_approval_ttl(31 * DAY_MS)).contains("between 1 minute and 30 days"));
    ctx(agent(), T0);
    assert!(panics(|| c.set_approval_ttl(3_600_000)).contains("owner only"));
    ctx(owner(), T0);
    c.set_approval_ttl(3_600_000);
    assert_eq!(c.get_config().approval_ttl_ms, 3_600_000);
}

// ---------------------------------------------------- stuck payment recovery

#[test]
fn a_stuck_payment_can_only_be_reconciled_by_the_owner_after_the_timeout() {
    let mut c = setup();
    pay(&mut c, "p", NEAR / 10, T0);
    ctx(owner(), T0 + IN_FLIGHT_RECOVERY_MS - 1);
    assert!(panics(|| c.reconcile_stuck(key("p"), false)).contains("too early"));
    ctx(agent(), T0 + IN_FLIGHT_RECOVERY_MS);
    assert!(panics(|| c.reconcile_stuck(key("p"), false)).contains("owner only"));
}

#[test]
fn owner_reconciles_a_stuck_failed_payment_and_a_late_callback_is_refused() {
    let mut c = setup();
    pay(&mut c, "p", NEAR / 10, T0);
    assert_eq!(c.get_balances().in_flight.0, NEAR / 10);
    ctx(owner(), T0 + IN_FLIGHT_RECOVERY_MS);
    c.reconcile_stuck(key("p"), false);
    let r = c.get_request(key("p")).unwrap();
    assert_eq!(r.status, Status::Failed);
    assert_eq!(r.failure_reason.as_deref(), Some("reconciled_by_owner"));
    assert_eq!(c.get_agent(agent()).unwrap().reserved.0, 0);
    assert_eq!(c.get_balances().in_flight.0, 0);
    assert!(c.list_open().is_empty());
    assert!(get_logs().iter().any(|l| l.contains("payment_reconciled")));
    // The original callback finally arrives: it can't settle it a second time.
    callback(true, T0 + IN_FLIGHT_RECOVERY_MS + 1);
    assert!(panics(|| c.on_payout(key("p"))).contains("already reconciled"));
    // Nor can the owner reconcile it again.
    ctx(owner(), T0 + IN_FLIGHT_RECOVERY_MS + 2);
    assert!(panics(|| c.reconcile_stuck(key("p"), true)).contains("not in flight"));
}

#[test]
fn owner_reconciles_a_stuck_payment_that_went_through() {
    let mut c = setup();
    pay(&mut c, "p", NEAR / 10, T0);
    ctx(owner(), T0 + IN_FLIGHT_RECOVERY_MS);
    c.reconcile_stuck(key("p"), true);
    assert_eq!(status(&c, "p"), Status::Settled);
    let a = c.get_agent(agent()).unwrap();
    assert_eq!((a.spent.0, a.reserved.0), (NEAR / 10, 0));
    assert_eq!(c.get_balances().shared_spent.0, NEAR / 10);
}

#[test]
fn a_reconciled_token_payment_that_did_not_go_through_returns_to_the_balance() {
    let mut c = setup();
    ctx(owner(), T0);
    c.add_token(usdc(), "USDC".into(), 6, U128(100 * USDC));
    c.set_agent_token_limits(agent(), usdc(), U128(20 * USDC), U128(50 * USDC), U128(15 * USDC));
    ctx(usdc(), T0);
    let _ = c.ft_on_transfer(owner(), U128(100 * USDC), String::new());
    ctx(agent(), T0);
    c.request_payment("t".into(), vendor(), U128(5 * USDC), None, Some(usdc()), None);
    let bal = |c: &Banbo| c.list_tokens()[0].balance.0;
    assert_eq!(bal(&c), 95 * USDC);
    ctx(owner(), T0 + IN_FLIGHT_RECOVERY_MS);
    c.reconcile_stuck(key("t"), false);
    assert_eq!(bal(&c), 100 * USDC);
    assert_eq!(c.get_agent_token_limits(agent())[0].1.reserved.0, 0);
}

#[test]
fn an_approved_payment_counts_its_timeout_from_approval() {
    let mut c = setup();
    pay(&mut c, "big", 8 * NEAR / 10, T0);
    let approved_at = T0 + DAY_MS;
    ctx(owner(), approved_at);
    let _ = c.approve(key("big"));
    ctx(owner(), approved_at + IN_FLIGHT_RECOVERY_MS - 1);
    assert!(panics(|| c.reconcile_stuck(key("big"), false)).contains("too early"));
    ctx(owner(), approved_at + IN_FLIGHT_RECOVERY_MS);
    c.reconcile_stuck(key("big"), false);
    assert_eq!(status(&c, "big"), Status::Failed);
}

// --------------------------------------------------------------- remove agent

#[test]
fn removing_an_agent_waits_for_its_open_payments() {
    let mut c = setup();
    pay(&mut c, "big", 8 * NEAR / 10, T0);
    ctx(owner(), T0);
    assert!(panics(|| c.remove_agent(agent())).contains("pending or in flight"));
    c.decline(key("big"));
    c.remove_agent(agent());
    assert!(get_logs().iter().any(|l| l.contains("agent_removed")));
    assert!(c.get_agent(agent()).is_none());
    assert!(c.list_agents().is_empty());
    assert_eq!(
        pay(&mut c, "after", NEAR / 10, T0 + 1),
        RequestOutcome::Rejected { reason: "unknown_agent".into() }
    );
}

#[test]
fn removing_an_agent_deletes_its_token_limits_and_checks_their_reservations() {
    let mut c = setup();
    ctx(owner(), T0);
    c.add_token(usdc(), "USDC".into(), 6, U128(100 * USDC));
    c.set_agent_token_limits(agent(), usdc(), U128(20 * USDC), U128(50 * USDC), U128(15 * USDC));
    ctx(usdc(), T0);
    let _ = c.ft_on_transfer(owner(), U128(100 * USDC), String::new());
    ctx(agent(), T0);
    c.request_payment("t".into(), vendor(), U128(5 * USDC), None, Some(usdc()), None);
    ctx(owner(), T0);
    assert!(panics(|| c.remove_agent(agent())).contains("pending or in flight"));
    callback(true, T0 + 1);
    c.on_payout(key("t"));
    ctx(owner(), T0 + 2);
    c.remove_agent(agent());
    assert!(c.get_agent_token_limits(agent()).is_empty());
    // Re-adding starts from scratch: no leftover token limits.
    c.add_agent(agent(), U128(NEAR), U128(10 * NEAR), U128(NEAR / 2));
    ctx(agent(), T0 + 3);
    assert_eq!(
        c.request_payment("t2".into(), vendor(), U128(USDC), None, Some(usdc()), None),
        RequestOutcome::Rejected { reason: "token_not_enabled_for_agent".into() }
    );
}

#[test]
fn only_the_owner_removes_agents() {
    let mut c = setup();
    ctx(agent(), T0);
    assert!(panics(|| c.remove_agent(agent())).contains("owner only"));
    ctx(owner(), T0);
    assert!(panics(|| c.remove_agent(vendor())).contains("unknown agent"));
}

// ------------------------------------------------------ ownership transfer

#[test]
fn ownership_moves_only_when_the_new_owner_accepts() {
    let mut c = setup();
    let next = acct("next-owner.testnet");
    ctx(owner(), T0);
    c.propose_owner(Some(next.clone()));
    assert_eq!(c.get_config().owner, owner());
    assert_eq!(c.get_config().pending_owner, Some(next.clone()));
    // Someone else can't take it.
    ctx(agent(), T0);
    assert!(panics(|| c.accept_ownership()).contains("not the proposed owner"));
    ctx(next.clone(), T0);
    c.accept_ownership();
    let cfg = c.get_config();
    assert_eq!((cfg.owner, cfg.pending_owner), (next.clone(), None));
    // The old owner has lost its rights, the new one has them.
    ctx(owner(), T0);
    assert!(panics(|| c.pause()).contains("owner only"));
    ctx(next, T0);
    c.pause();
    assert!(get_logs().iter().any(|l| l.contains("paused")));
}

#[test]
fn a_proposal_can_be_cancelled_or_replaced() {
    let mut c = setup();
    let a = acct("a.testnet");
    let b = acct("b.testnet");
    ctx(owner(), T0);
    c.propose_owner(Some(a.clone()));
    c.propose_owner(Some(b.clone()));
    ctx(a.clone(), T0);
    assert!(panics(|| c.accept_ownership()).contains("not the proposed owner"));
    ctx(owner(), T0);
    c.propose_owner(None);
    ctx(b, T0);
    assert!(panics(|| c.accept_ownership()).contains("not the proposed owner"));
    ctx(agent(), T0);
    assert!(panics(|| c.propose_owner(Some(a))).contains("owner only"));
    ctx(owner(), T0);
    assert!(panics(|| c.propose_owner(Some(owner()))).contains("already the owner"));
}

// --------------------------------------------------- bounded payment history

fn settle(c: &mut Banbo, id: &str, ts: u64) {
    callback(true, ts);
    assert!(c.on_payout(key(id)));
}

#[test]
fn old_finished_records_are_deleted_past_the_history_limit() {
    let mut c = setup();
    ctx(owner(), T0);
    c.set_history_limit(100);
    c.add_agent(agent(), U128(NEAR), U128(10 * NEAR), U128(NEAR));
    for i in 0..106u64 {
        let id = format!("p{i}");
        pay(&mut c, &id, 1, T0 + i);
        settle(&mut c, &id, T0 + i);
    }
    for i in 0..6 {
        assert!(c.get_request(key(&format!("p{i}"))).is_none(), "p{i} should be pruned");
    }
    assert!(c.get_request(key("p6")).is_some());
    let page = c.list_requests(None, Some(100));
    assert_eq!(page.len(), 100);
    assert_eq!(page[0].request_id, "p105");
    assert_eq!(page[99].request_id, "p6");
    let next = c.list_requests(Some(95), Some(10));
    assert_eq!(next.iter().map(|r| r.request_id.as_str()).collect::<Vec<_>>(), ["p10", "p9", "p8", "p7", "p6"]);
    assert!(c.list_requests(Some(100), None).is_empty());
}

#[test]
fn history_pruning_frees_storage() {
    let mut c = setup();
    ctx(owner(), T0);
    c.set_history_limit(100);
    c.add_agent(agent(), U128(NEAR), U128(10 * NEAR), U128(NEAR));
    for i in 0..100u64 {
        let id = format!("p{i}");
        pay(&mut c, &id, 1, T0 + i);
        settle(&mut c, &id, T0 + i);
    }
    let full = env::storage_usage();
    for i in 100..150u64 {
        let id = format!("p{i}");
        pay(&mut c, &id, 1, T0 + i);
        settle(&mut c, &id, T0 + i);
    }
    let after = env::storage_usage();
    // Same-sized records replace the old ones, so storage stays flat.
    assert!(after <= full + 200, "storage grew from {full} to {after}");
}

#[test]
fn an_open_payment_keeps_its_record_until_it_finishes() {
    let mut c = setup();
    ctx(owner(), T0);
    c.set_history_limit(100);
    pay(&mut c, "big", 8 * NEAR / 10, T0);
    ctx(owner(), T0);
    c.add_agent(agent(), U128(NEAR), U128(10 * NEAR), U128(NEAR));
    for i in 0..105u64 {
        let id = format!("p{i}");
        pay(&mut c, &id, 1, T0 + i);
        settle(&mut c, &id, T0 + i);
    }
    // Out of the history window, but still pending: kept and listed as open.
    assert_eq!(status(&c, "big"), Status::PendingApproval);
    assert!(!c.list_requests(None, Some(100)).iter().any(|r| r.request_id == "big"));
    assert_eq!(c.list_open()[0].request_id, "big");
    // Once decided, its record is deleted like any other old one.
    ctx(owner(), T0 + 200);
    c.decline(key("big"));
    assert!(c.get_request(key("big")).is_none());
    assert!(c.list_open().is_empty());
    assert_eq!(c.get_agent(agent()).unwrap().reserved.0, 0);
}

#[test]
fn history_limit_is_bounded_and_owner_only() {
    let mut c = setup();
    ctx(owner(), T0);
    assert!(panics(|| c.set_history_limit(99)).contains("between 100 and 10000"));
    assert!(panics(|| c.set_history_limit(10_001)).contains("between 100 and 10000"));
    ctx(agent(), T0);
    assert!(panics(|| c.set_history_limit(500)).contains("owner only"));
    assert_eq!(c.get_config().history_limit, DEFAULT_HISTORY_LIMIT);
}

#[test]
fn open_payments_are_capped() {
    let mut c = setup();
    ctx(owner(), T0);
    c.add_agent(agent(), U128(NEAR), U128(10 * NEAR), U128(NEAR));
    for i in 0..MAX_OPEN {
        assert!(matches!(pay(&mut c, &format!("p{i}"), 1, T0), RequestOutcome::Dispatched { .. }));
    }
    assert_eq!(
        pay(&mut c, "one-more", 1, T0),
        RequestOutcome::Rejected { reason: "too_many_open_payments".into() }
    );
    settle(&mut c, "p0", T0 + 1);
    assert!(matches!(pay(&mut c, "one-more", 1, T0 + 2), RequestOutcome::Dispatched { .. }));
}
