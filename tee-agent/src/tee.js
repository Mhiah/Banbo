// Everything that touches the TEE: the agent's NEAR key, the TDX quote and
// the measurement the owner approves.
//
// The key comes from dstack's key management service, which only hands it to
// a VM of this app whose measurements match, so it survives restarts but can
// never be read outside the TEE. The agent's account is the implicit account
// of that key: there is no other key that controls it.
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import { utils, KeyPair } from 'near-api-js';

const KEY_PATH = 'banbo/agent/near-ed25519';

/** NEAR key pair + implicit account from 32+ bytes of key material. */
export function agentKeyFromMaterial(material) {
  const seed = crypto.createHash('sha256').update('banbo-tee-agent-v1').update(Buffer.from(material)).digest();
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
  const keyPair = KeyPair.fromString(`ed25519:${utils.serialize.base_encode(Buffer.from(kp.secretKey))}`);
  const accountId = Buffer.from(kp.publicKey).toString('hex');
  return { keyPair, accountId, publicKey: keyPair.getPublicKey().toString() };
}

export async function agentKey(client) {
  const r = await client.getKey(KEY_PATH, 'near');
  return agentKeyFromMaterial(r.key);
}

/** report_data the contract expects: implicit account (32 bytes) || 32 zero bytes. */
export function reportData(accountId) {
  if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error('not an implicit account');
  return Buffer.concat([Buffer.from(accountId, 'hex'), Buffer.alloc(32)]);
}

/** dstack versions differ: tcb_info may be an object or a JSON string. */
export function tcbInfoOf(info) {
  const t = typeof info.tcb_info === 'string' ? JSON.parse(info.tcb_info) : info.tcb_info;
  const compose = t.compose_hash ?? info.compose_hash ?? crypto.createHash('sha256').update(t.app_compose).digest('hex');
  return { ...t, compose_hash: compose };
}

/** What the owner pastes into the dashboard to approve this image. */
export function measurementOf(tcb) {
  const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
  const kp = (tcb.event_log ?? []).filter((e) => e.imr === 3 && e.event === 'key-provider');
  return {
    mrtd: strip(tcb.mrtd),
    rtmr0: strip(tcb.rtmr0),
    rtmr1: strip(tcb.rtmr1),
    rtmr2: strip(tcb.rtmr2),
    compose_hash: strip(tcb.compose_hash),
    key_provider_digest: kp.length === 1 ? strip(kp[0].digest) : null,
  };
}

/** Collateral byte fields as hex, which is what the contract parses. */
export function normalizeCollateral(c) {
  const hex = (v) => (Array.isArray(v) || v instanceof Uint8Array ? Buffer.from(v).toString('hex') : String(v ?? '').replace(/^0x/, ''));
  const out = {
    pck_crl_issuer_chain: c.pck_crl_issuer_chain,
    root_ca_crl: hex(c.root_ca_crl),
    pck_crl: hex(c.pck_crl),
    tcb_info_issuer_chain: c.tcb_info_issuer_chain,
    tcb_info: c.tcb_info,
    tcb_info_signature: hex(c.tcb_info_signature),
    qe_identity_issuer_chain: c.qe_identity_issuer_chain,
    qe_identity: c.qe_identity,
    qe_identity_signature: hex(c.qe_identity_signature),
  };
  if (c.pck_certificate_chain) out.pck_certificate_chain = c.pck_certificate_chain;
  return out;
}

/**
 * Build the `attest_agent` argument: a fresh quote bound to this account, the
 * Intel collateral for it, and the VM's event log and app compose.
 * `getCollateral(quoteBytes)` defaults to Phala's PCCS mirror of Intel's.
 */
export async function buildAttestation(client, accountId, getCollateral) {
  const q = await client.getQuote(reportData(accountId));
  const quoteHex = String(q.quote).replace(/^0x/, '');
  const collateral = normalizeCollateral(await getCollateral(Buffer.from(quoteHex, 'hex')));
  const info = await client.info();
  const tcb = tcbInfoOf(info);
  // The quote's own event log is the freshest; fall back to info's.
  const eventLog = q.event_log ? (typeof q.event_log === 'string' ? JSON.parse(q.event_log) : q.event_log) : tcb.event_log;
  return {
    attestation: {
      quote: quoteHex,
      collateral,
      tcb_info: { compose_hash: tcb.compose_hash, app_compose: tcb.app_compose, event_log: eventLog },
    },
    measurement: measurementOf(tcb),
  };
}
