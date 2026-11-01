//! TEE attestation for agents (private mode).
//!
//! A private agent runs inside an Intel TDX confidential VM managed by dstack
//! (the stack NEAR AI Cloud and Phala Cloud run on). It creates its NEAR key
//! inside the VM, so its account is the implicit account of that key, and it
//! asks the hardware for a quote whose `report_data` is that account. The
//! contract then checks, on-chain:
//!
//! 1. the quote is signed by genuine Intel TDX hardware with an acceptable TCB
//!    status (Intel DCAP verification via the `dcap-qvl` crate);
//! 2. `report_data` is the caller's own account, so the quote can't be
//!    replayed by anyone else;
//! 3. the VM's firmware and OS (MRTD, RTMR0-2) and the app it runs (the
//!    docker compose hash, bound into RTMR3 through the replayed event log)
//!    match a measurement the owner approved;
//! 4. optionally, the physical CPU (PPID) is one the owner approved.
//!
//! Only then is the agent marked as attested, for a limited time.

use near_sdk::near;
use sha2::{Digest, Sha256, Sha384};

/// dstack measures every RTMR3 event with this event type.
pub const DSTACK_EVENT_TYPE: u32 = 0x0800_0001;
const RTMR3: u32 = 3;
const COMPOSE_HASH_EVENT: &str = "compose-hash";
const KEY_PROVIDER_EVENT: &str = "key-provider";
pub const TCB_UP_TO_DATE: &str = "UpToDate";
pub const TCB_SW_HARDENING: &str = "SWHardeningNeeded";

/// What the owner approves: the exact VM image and app an agent must run.
/// All values are lowercase hex.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TeeMeasurement {
    /// Virtual firmware (48 bytes).
    pub mrtd: String,
    /// Firmware config / boot loader (48 bytes).
    pub rtmr0: String,
    /// Kernel, command line, initrd (48 bytes).
    pub rtmr1: String,
    /// Root filesystem (48 bytes).
    pub rtmr2: String,
    /// sha256 of the dstack app compose: the containers the VM runs (32 bytes).
    pub compose_hash: String,
    /// Digest of dstack's key-provider event (48 bytes), to pin which key
    /// management service the VM uses. None = any.
    pub key_provider_digest: Option<String>,
}

impl TeeMeasurement {
    /// Lowercases and checks lengths; returns the normalized measurement.
    pub fn normalized(&self) -> Result<Self, String> {
        let h = |name: &str, v: &str, len: usize| -> Result<String, String> {
            let v = v.trim().trim_start_matches("0x").to_ascii_lowercase();
            if v.len() != len * 2 || !v.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(format!("{} must be {} bytes of hex", name, len));
            }
            Ok(v)
        };
        Ok(Self {
            mrtd: h("mrtd", &self.mrtd, 48)?,
            rtmr0: h("rtmr0", &self.rtmr0, 48)?,
            rtmr1: h("rtmr1", &self.rtmr1, 48)?,
            rtmr2: h("rtmr2", &self.rtmr2, 48)?,
            compose_hash: h("compose_hash", &self.compose_hash, 32)?,
            key_provider_digest: match &self.key_provider_digest {
                Some(k) => Some(h("key_provider_digest", k, 48)?),
                None => None,
            },
        })
    }

    /// Stable id: sha256 over every field, hex, first 16 bytes.
    pub fn id(&self) -> String {
        let s = format!(
            "{}|{}|{}|{}|{}|{}",
            self.mrtd,
            self.rtmr0,
            self.rtmr1,
            self.rtmr2,
            self.compose_hash,
            self.key_provider_digest.as_deref().unwrap_or("")
        );
        hex::encode(&Sha256::digest(s.as_bytes())[..16])
    }
}

/// Intel collateral for verifying a quote, as fetched from a PCCS. Byte
/// fields are hex; the rest are the PEM / JSON strings Intel serves.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TeeCollateral {
    pub pck_crl_issuer_chain: String,
    pub root_ca_crl: String,
    pub pck_crl: String,
    pub tcb_info_issuer_chain: String,
    pub tcb_info: String,
    pub tcb_info_signature: String,
    pub qe_identity_issuer_chain: String,
    pub qe_identity: String,
    pub qe_identity_signature: String,
    #[serde(default)]
    pub pck_certificate_chain: Option<String>,
}

/// One RTMR event from dstack's event log.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TeeEvent {
    pub imr: u32,
    pub event_type: u32,
    pub digest: String,
    pub event: String,
    pub event_payload: String,
}

/// The parts of dstack's `tcb_info` the contract needs. dstack's full
/// object can be passed as is; extra fields are ignored.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TeeTcbInfo {
    pub compose_hash: String,
    pub app_compose: String,
    pub event_log: Vec<TeeEvent>,
}

/// What an agent submits to `attest_agent`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TeeAttestation {
    /// The TDX quote, hex.
    pub quote: String,
    pub collateral: TeeCollateral,
    pub tcb_info: TeeTcbInfo,
}

/// An agent's accepted attestation.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TeeInfo {
    pub measurement_id: String,
    pub compose_hash: String,
    /// Physical CPU id from the PCK certificate, hex.
    pub ppid: String,
    pub tcb_status: String,
    pub attested_at_ms: u64,
    pub valid_until_ms: u64,
}

/// The values a successful hardware check yields.
pub struct Verified {
    pub measurement_id: String,
    pub compose_hash: String,
    pub ppid: String,
    pub tcb_status: String,
}

fn unhex(name: &str, s: &str) -> Result<Vec<u8>, String> {
    hex::decode(s.trim().trim_start_matches("0x")).map_err(|_| format!("{} is not hex", name))
}

fn collateral(c: &TeeCollateral) -> Result<dcap_qvl::QuoteCollateralV3, String> {
    Ok(dcap_qvl::QuoteCollateralV3 {
        pck_crl_issuer_chain: c.pck_crl_issuer_chain.clone(),
        root_ca_crl: unhex("root_ca_crl", &c.root_ca_crl)?,
        pck_crl: unhex("pck_crl", &c.pck_crl)?,
        tcb_info_issuer_chain: c.tcb_info_issuer_chain.clone(),
        tcb_info: c.tcb_info.clone(),
        tcb_info_signature: unhex("tcb_info_signature", &c.tcb_info_signature)?,
        qe_identity_issuer_chain: c.qe_identity_issuer_chain.clone(),
        qe_identity: c.qe_identity.clone(),
        qe_identity_signature: unhex("qe_identity_signature", &c.qe_identity_signature)?,
        pck_certificate_chain: c.pck_certificate_chain.clone(),
    })
}

/// `report_data` an agent's quote must carry: its implicit account (the
/// ed25519 public key, 32 bytes) followed by 32 zero bytes.
pub fn expected_report_data(implicit_account: &str) -> Result<[u8; 64], String> {
    if implicit_account.len() != 64
        || !implicit_account.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("a TEE agent must use the implicit account of a key created inside the TEE".into());
    }
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&hex::decode(implicit_account).unwrap());
    Ok(out)
}

/// Full check: Intel signature and TCB, then everything in `check_report`.
pub fn verify(
    att: &TeeAttestation,
    report_data: &[u8; 64],
    now_secs: u64,
    allow_sw_hardening: bool,
    measurements: &[(String, TeeMeasurement)],
    ppids: &[String],
) -> Result<Verified, String> {
    let quote = unhex("quote", &att.quote)?;
    let coll = collateral(&att.collateral)?;
    let report = dcap_qvl::verify::verify(&quote, &coll, now_secs).map_err(|e| format!("quote rejected: {}", e))?;
    let ok_status = report.status == TCB_UP_TO_DATE || (allow_sw_hardening && report.status == TCB_SW_HARDENING);
    if !ok_status {
        return Err(format!("TCB status {} is not accepted", report.status));
    }
    let td = report.report.as_td10().ok_or("not a TDX quote")?;
    let (measurement_id, compose_hash, ppid) =
        check_report(td, &report.ppid, &att.tcb_info, report_data, measurements, ppids)?;
    Ok(Verified { measurement_id, compose_hash, ppid, tcb_status: report.status })
}

/// The checks after the Intel signature: report data, RTMR3 replay, app
/// compose, approved measurement, approved CPU. Pure, so it is unit-tested
/// with synthetic reports.
pub fn check_report(
    td: &dcap_qvl::quote::TDReport10,
    ppid: &[u8],
    tcb: &TeeTcbInfo,
    report_data: &[u8; 64],
    measurements: &[(String, TeeMeasurement)],
    ppids: &[String],
) -> Result<(String, String, String), String> {
    if &td.report_data != report_data {
        return Err("report_data does not match the calling account".into());
    }
    let ppid_hex = hex::encode(ppid);
    if !ppids.is_empty() && !ppids.iter().any(|p| p == &ppid_hex) {
        return Err(format!("CPU {} is not approved", ppid_hex));
    }

    // Replay RTMR3 from the event log; every event digest must be honest.
    let mut rtmr3 = [0u8; 48];
    for e in tcb.event_log.iter().filter(|e| e.imr == RTMR3) {
        if e.event_type != DSTACK_EVENT_TYPE {
            return Err("unexpected RTMR3 event type".into());
        }
        let payload = unhex("event_payload", &e.event_payload)?;
        let digest = event_digest(e.event_type, &e.event, &payload);
        if unhex("event digest", &e.digest)? != digest {
            return Err(format!("event {} has a wrong digest", e.event));
        }
        let mut h = Sha384::new();
        h.update(rtmr3);
        h.update(digest);
        rtmr3 = h.finalize().into();
    }
    if rtmr3 != td.rt_mr3 {
        return Err("event log does not replay to RTMR3".into());
    }

    // The app compose: its hash is measured into RTMR3 and must match the text.
    let compose_events: Vec<&TeeEvent> =
        tcb.event_log.iter().filter(|e| e.imr == RTMR3 && e.event == COMPOSE_HASH_EVENT).collect();
    if compose_events.len() != 1 {
        return Err("expected exactly one compose-hash event".into());
    }
    let measured_compose = compose_events[0].event_payload.to_ascii_lowercase();
    let text_hash = hex::encode(Sha256::digest(tcb.app_compose.as_bytes()));
    if measured_compose != text_hash || tcb.compose_hash.to_ascii_lowercase() != text_hash {
        return Err("app compose does not match its measured hash".into());
    }
    // Newer dstack also puts the compose hash in MRCONFIGID: 0x01 || hash || 0..
    if td.mr_config_id != [0u8; 48] {
        let mut expect = [0u8; 48];
        expect[0] = 1;
        expect[1..33].copy_from_slice(&hex::decode(&text_hash).unwrap());
        if td.mr_config_id != expect {
            return Err("MRCONFIGID does not match the app compose".into());
        }
    }

    let key_provider: Vec<&TeeEvent> =
        tcb.event_log.iter().filter(|e| e.imr == RTMR3 && e.event == KEY_PROVIDER_EVENT).collect();
    let hexs = |b: &[u8]| hex::encode(b);
    for (id, m) in measurements {
        if m.mrtd != hexs(&td.mr_td)
            || m.rtmr0 != hexs(&td.rt_mr0)
            || m.rtmr1 != hexs(&td.rt_mr1)
            || m.rtmr2 != hexs(&td.rt_mr2)
            || m.compose_hash != text_hash
        {
            continue;
        }
        if let Some(want) = &m.key_provider_digest {
            if key_provider.len() != 1 || &key_provider[0].digest.to_ascii_lowercase() != want {
                continue;
            }
        }
        return Ok((id.clone(), text_hash, ppid_hex));
    }
    Err("the VM's measurements are not approved by the owner".into())
}

/// dstack's event digest: sha384(event_type_le || ":" || event || ":" || payload).
pub fn event_digest(event_type: u32, event: &str, payload: &[u8]) -> [u8; 48] {
    let mut h = Sha384::new();
    h.update(event_type.to_le_bytes());
    h.update(b":");
    h.update(event.as_bytes());
    h.update(b":");
    h.update(payload);
    h.finalize().into()
}
