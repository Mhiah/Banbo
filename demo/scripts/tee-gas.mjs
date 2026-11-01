// Measures the gas of on-chain Intel TDX quote verification with a genuine
// sample quote. Needs the measurement-only build (same flags as build.sh):
//   cd contract
//   RUSTFLAGS="--cfg near -C target-cpu=mvp -C link-arg=-s" cargo build --release \
//     --target wasm32-unknown-unknown --features tee-gas-probe
//   ../demo/node_modules/.bin/wasm-opt -Oz --signext-lowering --llvm-memory-copy-fill-lowering \
//     --enable-bulk-memory --enable-sign-ext target/wasm32-unknown-unknown/release/banbo.wasm -o /tmp/probe.wasm
//   cd ../demo && node scripts/tee-gas.mjs /tmp/probe.wasm
// The sample collateral was valid in July 2025, so the probe takes the time as
// an argument; the deployed contract always uses the block time.
import fs from 'node:fs';
import pkg from 'near-workspaces';
const { Worker } = pkg;
const C = new URL('../../contract/test-data/', import.meta.url).pathname;
const quote = fs.readFileSync(C + 'tdx_quote.bin').toString('hex');
const collateral = JSON.parse(fs.readFileSync(C + 'tdx_quote_collateral.json', 'utf8'));
const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const v = await root.createSubAccount('probe', { initialBalance: '20000000000000000000000000' });
  await v.deploy(process.argv[2] ?? 'banbo-probe.wasm');
  await v.call(v, 'new', { owner: v.accountId, period_ms: 86400000, shared_cap: '1' });
  await v.call(v, 'approve_tee_measurement', { measurement: { mrtd: '11'.repeat(48), rtmr0: '22'.repeat(48), rtmr1: '33'.repeat(48), rtmr2: '44'.repeat(48), compose_hash: '55'.repeat(32), key_provider_digest: null } });
  const att = { quote, collateral, tcb_info: { compose_hash: '55'.repeat(32), app_compose: '{}', event_log: [] } };
  const acct = '7f'.repeat(32);
  for (const [label, t] of [['in window', 1751328000], ['expired collateral', 1751328000 + 120 * 86400]]) {
    const r = await v.callRaw(v, 'probe_tee_verify', { attestation: att, now_secs: t, account: acct }, { gas: '300000000000000' });
    const burnt = r.result.receipts_outcome.reduce((n, o) => n + o.outcome.gas_burnt, 0) + r.result.transaction_outcome.outcome.gas_burnt;
    console.log(label, '→', JSON.stringify(r.parseResult()), `| ${(burnt / 1e12).toFixed(1)} Tgas`, r.failures?.length ? JSON.stringify(r.failures).slice(0, 300) : '');
  }
} finally { await worker.tearDown(); }
