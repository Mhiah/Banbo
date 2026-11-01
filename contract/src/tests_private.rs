//! Private mode: hidden allowlist, encrypted memos, TEE-attested agents.
use super::*;
use crate::tee::{self, event_digest, TeeEvent, TeeMeasurement, TeeTcbInfo, Verified, DSTACK_EVENT_TYPE};
use dcap_qvl::quote::TDReport10;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 10u128.pow(24);
const DAY_MS: u64 = 86_400_000;
const SALT: &str = "5ab1e5a15ab1e5a15ab1e5a15ab1e5a15ab1e5a15ab1e5a15ab1e5a15ab1e5a1";
const OTHER_SALT: &str = "0000000000000000000000000000000000000000000000000000000000000001";
/// A TEE agent's implicit account (an ed25519 public key in hex).
const TEE_AGENT: &str = "7f1c3a5e9b2d4f6081a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7";

fn owner() -> AccountId {
    "owner.testnet".parse().unwrap()
}
fn vault() -> AccountId {
    "vault.testnet".parse().unwrap()
}
fn agent() -> AccountId {
    "agent1.testnet".parse().unwrap()
}
fn tee_agent() -> AccountId {
    TEE_AGENT.parse().unwrap()
}
fn secret_vendor() -> AccountId {
    "quiet-vendor.testnet".parse().unwrap()
}
fn attacker() -> AccountId {
    "attacker.testnet".parse().unwrap()
}

fn ctx(caller: AccountId, ts_ms: u64) {
    let c = VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(caller)
        .account_balance(NearToken::from_yoctonear(10 * NEAR))
        .block_timestamp(ts_ms * 1_000_000)
        .build();
    testing_env!(c);
}

fn enc(n: usize) -> String {
    format!("enc1:{}", "A".repeat(n))
}

/// Vault with one ordinary agent and one TEE agent, nothing allowlisted.
fn setup() -> Banbo {
    ctx(owner(), 1_000);
    let mut c = Banbo::new(owner(), DAY_MS, U128(5 * NEAR));
    c.add_agent(agent(), U128(NEAR / 2), U128(3 * NEAR), U128(NEAR / 4));
    c.add_agent(tee_agent(), U128(NEAR / 2), U128(3 * NEAR), U128(NEAR));
    c
}

fn fp(account: &AccountId, salt: &str) -> String {
    recipient_fingerprint(account, salt).unwrap()
}

fn hide(c: &mut Banbo, account: &AccountId, salt: &str) {
    ctx(owner(), 1_000);
    c.allow_hidden_recipient(fp(account, salt), Some(enc(40)));
}

fn pay_as(
    c: &mut Banbo,
    who: AccountId,
    id: &str,
    to: AccountId,
    amount: u128,
    salt: Option<&str>,
    memo: Option<String>,
) -> RequestOutcome {
    ctx(who, 2_000);
    c.request_payment(id.into(), to, U128(amount), memo, None, salt.map(String::from))
}

fn rejected(r: &str) -> RequestOutcome {
    RequestOutcome::Rejected { reason: r.into() }
}

// ---------------------------------------------------------- hidden allowlist

#[test]
fn fingerprint_is_salted_and_bound_to_the_account() {
    let a = fp(&secret_vendor(), SALT);
    assert_eq!(a.len(), 64);
    assert_ne!(a, fp(&secret_vendor(), OTHER_SALT));
    assert_ne!(a, fp(&attacker(), SALT));
    // Must match what the dashboard and agents compute (sha256 of this string).
    let expect = hex::encode(Sha256::digest(format!("banbo-recipient-v1:quiet-vendor.testnet:{}", SALT)));
    assert_eq!(a, expect);
    // Same vector as demo/src/privacy.js and dashboard/src/privacy.test.ts.
    assert_eq!(
        fp(&"quiet-vendor.near".parse().unwrap(), SALT),
        "f9ae7fcae4957690fa095cf6a61488e15fb351d612b6a3e343a8f946fd2af7b8"
    );
    assert!(recipient_fingerprint(&secret_vendor(), "abc").is_none());
    assert!(recipient_fingerprint(&secret_vendor(), &SALT.to_uppercase()).is_none());
}

#[test]
fn hidden_recipient_is_paid_with_its_salt_and_state_shows_only_the_fingerprint() {
    let mut c = setup();
    hide(&mut c, &secret_vendor(), SALT);
    let listed = c.list_hidden_recipients();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].fingerprint, fp(&secret_vendor(), SALT));
    assert!(c.list_allowlist().is_empty(), "nothing in the public allowlist");
    let state = near_sdk::serde_json::to_string(&listed).unwrap();
    assert!(!state.contains("quiet-vendor"), "account name never stored");

    let out = pay_as(&mut c, agent(), "h1", secret_vendor(), NEAR / 10, Some(SALT), None);
    assert!(matches!(out, RequestOutcome::Dispatched { .. }), "{out:?}");
    let req = c.get_request(format!("{}:h1", agent())).unwrap();
    assert_eq!(req.recipient_fingerprint, Some(fp(&secret_vendor(), SALT)));
}

#[test]
fn hidden_recipient_without_the_right_salt_is_refused() {
    let mut c = setup();
    hide(&mut c, &secret_vendor(), SALT);
    assert_eq!(pay_as(&mut c, agent(), "n1", secret_vendor(), NEAR / 10, None, None), rejected("recipient_not_allowlisted"));
    assert_eq!(
        pay_as(&mut c, agent(), "n2", secret_vendor(), NEAR / 10, Some(OTHER_SALT), None),
        rejected("recipient_not_allowlisted")
    );
    assert_eq!(pay_as(&mut c, agent(), "n3", secret_vendor(), NEAR / 10, Some("zz"), None), rejected("recipient_not_allowlisted"));
}

#[test]
fn a_leaked_salt_does_not_let_an_attacker_get_paid() {
    let mut c = setup();
    hide(&mut c, &secret_vendor(), SALT);
    // Injection gets the agent to reuse the vendor's salt for the attacker.
    let out = pay_as(&mut c, agent(), "x1", attacker(), NEAR / 10, Some(SALT), None);
    assert_eq!(out, rejected("recipient_not_allowlisted"));
    assert_eq!(c.list_blocked(None)[0].recipient, attacker());
}

#[test]
fn hidden_recipients_respect_the_cooldown() {
    let mut c = setup();
    ctx(owner(), 1_000);
    c.set_risk_rules(DAY_MS, 0);
    hide(&mut c, &secret_vendor(), SALT);
    assert_eq!(c.list_hidden_recipients()[0].payable_from_ms, 1_000 + DAY_MS);
    assert_eq!(pay_as(&mut c, agent(), "c1", secret_vendor(), NEAR / 10, Some(SALT), None), rejected("recipient_in_cooldown"));
    ctx(agent(), 1_000 + DAY_MS);
    let out = c.request_payment("c2".into(), secret_vendor(), U128(NEAR / 10), None, None, Some(SALT.into()));
    assert!(matches!(out, RequestOutcome::Dispatched { .. }), "{out:?}");
}

#[test]
fn re_adding_a_hidden_recipient_keeps_its_original_add_time() {
    let mut c = setup();
    ctx(owner(), 1_000);
    c.set_risk_rules(DAY_MS, 0);
    c.allow_hidden_recipient(fp(&secret_vendor(), SALT), None);
    ctx(owner(), 50_000);
    c.allow_hidden_recipient(fp(&secret_vendor(), SALT), Some(enc(8)));
    let e = &c.list_hidden_recipients()[0];
    assert_eq!(e.added_at_ms, 1_000);
    assert_eq!(e.label, Some(enc(8)));
}

#[test]
fn removed_hidden_recipient_cannot_be_paid_or_approved() {
    let mut c = setup();
    hide(&mut c, &secret_vendor(), SALT);
    // Over agent1's approval threshold (0.25 NEAR): waits for the owner.
    let out = pay_as(&mut c, agent(), "p1", secret_vendor(), 4 * NEAR / 10, Some(SALT), None);
    assert!(matches!(out, RequestOutcome::PendingApproval { .. }), "{out:?}");
    ctx(owner(), 3_000);
    c.disallow_hidden_recipient(fp(&secret_vendor(), SALT));
    assert_eq!(pay_as(&mut c, agent(), "p2", secret_vendor(), NEAR / 10, Some(SALT), None), rejected("recipient_not_allowlisted"));
    ctx(owner(), 3_000);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.approve(format!("{}:p1", agent()));
    }));
    assert!(r.is_err(), "approval of a removed hidden recipient must fail");
}

#[test]
fn pending_hidden_payment_is_approved_while_still_listed() {
    let mut c = setup();
    hide(&mut c, &secret_vendor(), SALT);
    pay_as(&mut c, agent(), "p1", secret_vendor(), 4 * NEAR / 10, Some(SALT), None);
    ctx(owner(), 3_000);
    let _ = c.approve(format!("{}:p1", agent()));
    assert_eq!(c.get_request(format!("{}:p1", agent())).unwrap().status, Status::InFlight);
}

#[test]
#[should_panic(expected = "label must be encrypted")]
fn hidden_labels_must_be_encrypted() {
    let mut c = setup();
    ctx(owner(), 1_000);
    c.allow_hidden_recipient(fp(&secret_vendor(), SALT), Some("quiet-vendor.testnet".into()));
}

#[test]
#[should_panic(expected = "fingerprint must be 32 bytes of hex")]
fn hidden_fingerprint_must_be_a_hash() {
    let mut c = setup();
    ctx(owner(), 1_000);
    c.allow_hidden_recipient("quiet-vendor.testnet".into(), None);
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_add_hidden_recipients() {
    let mut c = setup();
    ctx(agent(), 1_000);
    c.allow_hidden_recipient(fp(&attacker(), SALT), None);
}

// ----------------------------------------------------------- encrypted memos

fn key() -> String {
    format!("x25519:{}", "ab".repeat(32))
}

#[test]
fn privacy_settings_are_validated() {
    let mut c = setup();
    ctx(owner(), 1_000);
    c.set_privacy(Some(key()), true);
    let cfg = c.get_config();
    assert_eq!(cfg.owner_encryption_key, Some(key()));
    assert!(cfg.encrypted_memos_only);
    for bad in [format!("x25519:{}", "AB".repeat(32)), "ed25519:abc".to_string(), format!("x25519:{}", "ab".repeat(31))] {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_privacy(Some(bad.clone()), false)));
        assert!(r.is_err(), "accepted bad key {bad}");
    }
}

#[test]
#[should_panic(expected = "set an encryption key before requiring encrypted memos")]
fn encrypted_only_needs_a_key() {
    let mut c = setup();
    ctx(owner(), 1_000);
    c.set_privacy(None, true);
}

#[test]
fn encrypted_only_rejects_plaintext_memos() {
    let mut c = setup();
    ctx(owner(), 1_000);
    c.allow_recipient(secret_vendor());
    c.set_privacy(Some(key()), true);
    let out = pay_as(&mut c, agent(), "m1", secret_vendor(), NEAR / 10, None, Some("invoice for Q3 report".into()));
    assert_eq!(out, rejected("memo_not_encrypted"));
    assert_eq!(c.list_blocked(None)[0].memo, "", "plaintext is not copied into state");
    assert!(!get_logs().iter().any(|l| l.contains("Q3 report")), "or into logs");
    let out = pay_as(&mut c, agent(), "m2", secret_vendor(), NEAR / 10, None, Some(enc(300)));
    assert!(matches!(out, RequestOutcome::Dispatched { .. }), "{out:?}");
    assert_eq!(c.get_request(format!("{}:m2", agent())).unwrap().memo, enc(300));
    let out = pay_as(&mut c, agent(), "m3", secret_vendor(), NEAR / 10, None, None);
    assert!(matches!(out, RequestOutcome::Dispatched { .. }), "empty memo is fine: {out:?}");
    // A prefix alone, or non-base64 after it, is not ciphertext.
    assert_eq!(pay_as(&mut c, agent(), "m4", secret_vendor(), NEAR / 10, None, Some("enc1:".into())), rejected("memo_not_encrypted"));
    assert_eq!(
        pay_as(&mut c, agent(), "m5", secret_vendor(), NEAR / 10, None, Some("enc1:hello world".into())),
        rejected("memo_not_encrypted")
    );
}

#[test]
fn encrypted_memos_are_kept_whole_in_the_blocked_log() {
    let mut c = setup();
    let memo = enc(400);
    pay_as(&mut c, agent(), "b1", attacker(), NEAR / 10, None, Some(memo.clone()));
    assert_eq!(c.list_blocked(None)[0].memo, memo);
}

#[test]
#[should_panic(expected = "memo too long")]
fn encrypted_memo_has_a_size_limit() {
    let mut c = setup();
    pay_as(&mut c, agent(), "b2", attacker(), NEAR / 10, None, Some(enc(600)));
}

#[test]
#[should_panic(expected = "memo too long")]
fn plaintext_memo_limit_is_unchanged() {
    let mut c = setup();
    pay_as(&mut c, agent(), "b3", attacker(), NEAR / 10, None, Some("x".repeat(300)));
}

// ---------------------------------------------------------- TEE attestation

fn h48(b: u8) -> String {
    hex::encode([b; 48])
}

fn compose() -> String {
    r#"{"manifest_version":2,"name":"banbo-agent","runner":"docker-compose"}"#.to_string()
}

fn compose_hash() -> String {
    hex::encode(Sha256::digest(compose().as_bytes()))
}

fn measurement() -> TeeMeasurement {
    TeeMeasurement {
        mrtd: h48(1),
        rtmr0: h48(2),
        rtmr1: h48(3),
        rtmr2: h48(4),
        compose_hash: compose_hash(),
        key_provider_digest: None,
    }
}

fn event(name: &str, payload: &[u8]) -> TeeEvent {
    TeeEvent {
        imr: 3,
        event_type: DSTACK_EVENT_TYPE,
        digest: hex::encode(event_digest(DSTACK_EVENT_TYPE, name, payload)),
        event: name.into(),
        event_payload: hex::encode(payload),
    }
}

fn replay(events: &[TeeEvent]) -> [u8; 48] {
    let mut r = [0u8; 48];
    for e in events.iter().filter(|e| e.imr == 3) {
        let mut h = sha2::Sha384::new();
        h.update(r);
        h.update(hex::decode(&e.digest).unwrap());
        r = h.finalize().into();
    }
    r
}

/// A dstack-shaped event log and the TD report it would produce.
fn synthetic(account: &str) -> (TDReport10, TeeTcbInfo) {
    let events = vec![
        event("system-preparing", b""),
        event("app-id", &[7u8; 20]),
        event("compose-hash", &hex::decode(compose_hash()).unwrap()),
        event("key-provider", br#"{"name":"kms","id":"abc"}"#),
        event("system-ready", b""),
    ];
    let mut report_data = [0u8; 64];
    report_data[..32].copy_from_slice(&hex::decode(account).unwrap());
    let td = TDReport10 {
        tee_tcb_svn: [0; 16],
        mr_seam: [0; 48],
        mr_signer_seam: [0; 48],
        seam_attributes: [0; 8],
        td_attributes: [0; 8],
        xfam: [0; 8],
        mr_td: [1; 48],
        mr_config_id: [0; 48],
        mr_owner: [0; 48],
        mr_owner_config: [0; 48],
        rt_mr0: [2; 48],
        rt_mr1: [3; 48],
        rt_mr2: [4; 48],
        rt_mr3: replay(&events),
        report_data,
    };
    (td, TeeTcbInfo { compose_hash: compose_hash(), app_compose: compose(), event_log: events })
}

fn check(td: &TDReport10, tcb: &TeeTcbInfo, ms: &[(String, TeeMeasurement)], ppids: &[String]) -> Result<(String, String, String), String> {
    let rd = tee::expected_report_data(TEE_AGENT).unwrap();
    tee::check_report(td, &[9u8; 16], tcb, &rd, ms, ppids)
}

fn approved() -> Vec<(String, TeeMeasurement)> {
    let m = measurement();
    vec![(m.id(), m)]
}

#[test]
fn genuine_report_with_approved_measurements_passes() {
    let (td, tcb) = synthetic(TEE_AGENT);
    let (id, compose, ppid) = check(&td, &tcb, &approved(), &[]).unwrap();
    assert_eq!(id, measurement().id());
    assert_eq!(compose, compose_hash());
    assert_eq!(ppid, hex::encode([9u8; 16]));
}

#[test]
fn quote_for_another_account_is_refused() {
    let other = "aa".repeat(32);
    let (td, tcb) = synthetic(&other);
    assert!(check(&td, &tcb, &approved(), &[]).unwrap_err().contains("report_data"));
}

#[test]
fn different_image_or_app_is_refused() {
    let (mut td, tcb) = synthetic(TEE_AGENT);
    td.rt_mr2 = [5; 48]; // different root filesystem
    assert!(check(&td, &tcb, &approved(), &[]).unwrap_err().contains("not approved"));

    let (td, tcb) = synthetic(TEE_AGENT);
    let mut other = measurement();
    other.compose_hash = "11".repeat(32);
    assert!(check(&td, &tcb, &[(other.id(), other)], &[]).unwrap_err().contains("not approved"));
}

#[test]
fn edited_app_compose_is_caught() {
    let (td, mut tcb) = synthetic(TEE_AGENT);
    tcb.app_compose = compose().replace("banbo-agent", "evil-agent");
    assert!(check(&td, &tcb, &approved(), &[]).unwrap_err().contains("app compose"));
}

#[test]
fn forged_event_log_is_caught() {
    // Swap in a different compose hash event but keep the old digest.
    let (td, mut tcb) = synthetic(TEE_AGENT);
    tcb.event_log[2].event_payload = "22".repeat(32);
    assert!(check(&td, &tcb, &approved(), &[]).unwrap_err().contains("wrong digest"));
    // Recompute the digest honestly: RTMR3 no longer replays.
    let (td, mut tcb) = synthetic(TEE_AGENT);
    tcb.event_log[2] = event("compose-hash", &[0x22; 32]);
    assert!(check(&td, &tcb, &approved(), &[]).unwrap_err().contains("RTMR3"));
    // Dropping an event also breaks the replay.
    let (td, mut tcb) = synthetic(TEE_AGENT);
    tcb.event_log.remove(0);
    assert!(check(&td, &tcb, &approved(), &[]).unwrap_err().contains("RTMR3"));
}

#[test]
fn two_compose_events_are_refused() {
    let (mut td, mut tcb) = synthetic(TEE_AGENT);
    tcb.event_log.push(event("compose-hash", &hex::decode(compose_hash()).unwrap()));
    td.rt_mr3 = replay(&tcb.event_log);
    assert!(check(&td, &tcb, &approved(), &[]).unwrap_err().contains("exactly one"));
}

#[test]
fn mrconfigid_must_match_when_present() {
    let (mut td, tcb) = synthetic(TEE_AGENT);
    let mut cfg = [0u8; 48];
    cfg[0] = 1;
    cfg[1..33].copy_from_slice(&hex::decode(compose_hash()).unwrap());
    td.mr_config_id = cfg;
    assert!(check(&td, &tcb, &approved(), &[]).is_ok());
    td.mr_config_id[5] ^= 1;
    assert!(check(&td, &tcb, &approved(), &[]).unwrap_err().contains("MRCONFIGID"));
}

#[test]
fn cpu_allowlist_and_key_provider_pinning() {
    let (td, tcb) = synthetic(TEE_AGENT);
    assert!(check(&td, &tcb, &approved(), &["00".repeat(16)]).unwrap_err().contains("CPU"));
    assert!(check(&td, &tcb, &approved(), &[hex::encode([9u8; 16])]).is_ok());

    let mut pinned = measurement();
    pinned.key_provider_digest = Some(tcb.event_log[3].digest.clone());
    assert!(check(&td, &tcb, &[(pinned.id(), pinned.clone())], &[]).is_ok());
    pinned.key_provider_digest = Some(h48(0xee));
    assert!(check(&td, &tcb, &[(pinned.id(), pinned)], &[]).is_err());
}

#[test]
fn measurements_are_normalized_and_validated() {
    let mut m = measurement();
    m.mrtd = format!("0x{}", m.mrtd.to_uppercase());
    assert_eq!(m.normalized().unwrap().mrtd, h48(1));
    m.rtmr1 = "abcd".into();
    assert!(m.normalized().unwrap_err().contains("rtmr1"));
}

fn tee_setup() -> (Banbo, String) {
    let mut c = setup();
    ctx(owner(), 1_000);
    c.allow_recipient(secret_vendor());
    let id = c.approve_tee_measurement(measurement());
    c.set_tee_policy(true, DAY_MS, false);
    (c, id)
}

fn attest_now(c: &mut Banbo, who: &AccountId, id: &str, ts: u64) {
    ctx(who.clone(), ts);
    c.record_attestation(
        who,
        Verified { measurement_id: id.into(), compose_hash: compose_hash(), ppid: "09".repeat(16), tcb_status: "UpToDate".into() },
    );
}

#[test]
fn with_require_tee_only_attested_agents_can_spend() {
    let (mut c, id) = tee_setup();
    assert!(c.get_config().require_tee);
    assert_eq!(pay_as(&mut c, agent(), "t1", secret_vendor(), NEAR / 10, None, None), rejected("agent_not_attested"));
    assert_eq!(pay_as(&mut c, tee_agent(), "t2", secret_vendor(), NEAR / 10, None, None), rejected("agent_not_attested"));
    attest_now(&mut c, &tee_agent(), &id, 1_500);
    let out = pay_as(&mut c, tee_agent(), "t3", secret_vendor(), NEAR / 10, None, None);
    assert!(matches!(out, RequestOutcome::Dispatched { .. }), "{out:?}");
    let info = c.get_agent_tee(tee_agent()).unwrap();
    assert_eq!(info.valid_until_ms, 1_500 + DAY_MS);
    assert_eq!(c.list_agent_tee().len(), 1);
    assert!(get_logs().iter().any(|l| l.contains("payment_reserved")));
}

#[test]
fn attestation_expires() {
    let (mut c, id) = tee_setup();
    attest_now(&mut c, &tee_agent(), &id, 1_000);
    ctx(tee_agent(), 1_000 + DAY_MS);
    let out = c.request_payment("e1".into(), secret_vendor(), U128(NEAR / 10), None, None, None);
    assert_eq!(out, rejected("attestation_expired"));
}

#[test]
fn removing_the_measurement_stops_agents_running_it() {
    let (mut c, id) = tee_setup();
    attest_now(&mut c, &tee_agent(), &id, 1_500);
    ctx(owner(), 1_600);
    c.remove_tee_measurement(id);
    assert_eq!(
        pay_as(&mut c, tee_agent(), "r1", secret_vendor(), NEAR / 10, None, None),
        rejected("agent_measurement_not_approved")
    );
}

#[test]
fn owner_can_revoke_an_attestation() {
    let (mut c, id) = tee_setup();
    attest_now(&mut c, &tee_agent(), &id, 1_500);
    ctx(owner(), 1_600);
    c.revoke_attestation(tee_agent());
    assert_eq!(pay_as(&mut c, tee_agent(), "v1", secret_vendor(), NEAR / 10, None, None), rejected("agent_not_attested"));
}

#[test]
fn require_tee_off_keeps_ordinary_agents_working() {
    let (mut c, _) = tee_setup();
    ctx(owner(), 1_600);
    c.set_tee_policy(false, DAY_MS, false);
    let out = pay_as(&mut c, agent(), "o1", secret_vendor(), NEAR / 10, None, None);
    assert!(matches!(out, RequestOutcome::Dispatched { .. }), "{out:?}");
}

fn dummy_attestation() -> TeeAttestation {
    let (_, tcb) = synthetic(TEE_AGENT);
    TeeAttestation {
        quote: "04000200".repeat(160),
        collateral: TeeCollateral {
            pck_crl_issuer_chain: String::new(),
            root_ca_crl: String::new(),
            pck_crl: String::new(),
            tcb_info_issuer_chain: String::new(),
            tcb_info: "{}".into(),
            tcb_info_signature: String::new(),
            qe_identity_issuer_chain: String::new(),
            qe_identity: "{}".into(),
            qe_identity_signature: String::new(),
            pck_certificate_chain: None,
        },
        tcb_info: tcb,
    }
}

#[test]
#[should_panic(expected = "attestation rejected: quote rejected")]
fn a_fake_quote_is_rejected_by_intel_verification() {
    let (mut c, _) = tee_setup();
    ctx(tee_agent(), 2_000);
    c.attest_agent(dummy_attestation());
}

#[test]
#[should_panic(expected = "implicit account")]
fn named_accounts_cannot_attest() {
    let (mut c, _) = tee_setup();
    ctx(agent(), 2_000);
    c.attest_agent(dummy_attestation());
}

#[test]
#[should_panic(expected = "the owner must add it first")]
fn unknown_tee_agents_cannot_attest() {
    let (mut c, _) = tee_setup();
    ctx(("cd".repeat(32)).parse().unwrap(), 2_000);
    c.attest_agent(dummy_attestation());
}

#[test]
#[should_panic(expected = "no approved TEE measurements")]
fn attesting_needs_an_approved_measurement() {
    let mut c = setup();
    ctx(tee_agent(), 2_000);
    c.attest_agent(dummy_attestation());
}

#[test]
#[should_panic(expected = "owner only")]
fn agents_cannot_approve_their_own_measurements() {
    let mut c = setup();
    ctx(tee_agent(), 2_000);
    c.approve_tee_measurement(measurement());
}

#[test]
#[should_panic(expected = "attestation_ttl_ms too short")]
fn attestation_ttl_has_a_floor() {
    let mut c = setup();
    ctx(owner(), 2_000);
    c.set_tee_policy(true, 1_000, false);
}

// A genuine Intel TDX quote (dcap-qvl sample, collateral valid 2025-06-19..07-19).
const REAL_QUOTE: &[u8] = include_bytes!("../test-data/tdx_quote.bin");
const REAL_COLLATERAL: &str = include_str!("../test-data/tdx_quote_collateral.json");
const IN_WINDOW_SECS: u64 = 1_751_328_000; // 2025-07-01

fn real_attestation() -> TeeAttestation {
    let (_, tcb) = synthetic(TEE_AGENT);
    TeeAttestation {
        quote: hex::encode(REAL_QUOTE),
        collateral: near_sdk::serde_json::from_str(REAL_COLLATERAL).unwrap(),
        tcb_info: tcb,
    }
}

#[test]
fn real_intel_quote_passes_signature_checks_and_is_then_bound_to_the_caller() {
    let rd = tee::expected_report_data(TEE_AGENT).unwrap();
    let err = match tee::verify(&real_attestation(), &rd, IN_WINDOW_SECS, true, &approved(), &[]) {
        Ok(_) => panic!("someone else's quote must not verify"),
        Err(e) => e,
    };
    // Intel's signature chain and collateral were accepted; what stops it is
    // that the quote was made for a different VM and key.
    assert!(!err.starts_with("quote rejected"), "{err}");
    assert!(err.contains("report_data") || err.contains("TCB status"), "{err}");
}

#[test]
fn real_quote_is_rejected_once_its_collateral_has_expired() {
    let rd = tee::expected_report_data(TEE_AGENT).unwrap();
    let err = tee::verify(&real_attestation(), &rd, IN_WINDOW_SECS + 120 * 86_400, true, &approved(), &[]).err().unwrap();
    assert!(err.starts_with("quote rejected"), "{err}");
}

#[test]
fn tampered_real_quote_fails_intel_verification() {
    let mut att = real_attestation();
    let mut q = REAL_QUOTE.to_vec();
    q[600] ^= 0x01; // inside the signed TD report
    att.quote = hex::encode(q);
    let rd = tee::expected_report_data(TEE_AGENT).unwrap();
    let err = tee::verify(&att, &rd, IN_WINDOW_SECS, true, &approved(), &[]).err().unwrap();
    assert!(err.starts_with("quote rejected"), "{err}");
}
