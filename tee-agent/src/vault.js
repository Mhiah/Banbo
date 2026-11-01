// The agent's side of the vault: read views, attest, request payments.
// The only transactions this agent ever signs are calls to its vault.
import { connect, keyStores } from 'near-api-js';
import { seal } from './privacy.js';

const TGAS = (n) => BigInt(n) * 10n ** 12n;

export async function openVault({ networkId, nodeUrl, vaultId, accountId, keyPair }) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(networkId, accountId, keyPair);
  const near = await connect({ networkId, nodeUrl, keyStore });
  const account = await near.account(accountId);
  const view = (method, args = {}) => account.viewFunction({ contractId: vaultId, methodName: method, args });

  return {
    accountId,
    view,
    async balance() {
      try { return BigInt((await account.getAccountBalance()).available); } catch { return 0n; }
    },
    /** Submit an attestation. Throws with the contract's reason if refused. */
    async attest(attestation) {
      return account.functionCall({ contractId: vaultId, methodName: 'attest_agent', args: { attestation }, gas: TGAS(300) });
    },
    /**
     * Pay through the vault. The memo is always sealed to the owner when the
     * vault has a key; the salt comes from runtime config, never from the model.
     */
    async requestPayment({ requestId, recipient, amount, token = null, memo = '', salts = {} }) {
      const cfg = await view('get_config');
      const sealed = memo && cfg.owner_encryption_key ? seal(memo, cfg.owner_encryption_key) : memo;
      const r = await account.functionCall({
        contractId: vaultId,
        methodName: 'request_payment',
        args: { request_id: requestId, recipient, amount, memo: sealed, token, recipient_salt: salts[recipient] ?? null },
        gas: TGAS(150),
      });
      const raw = r.status?.SuccessValue;
      return { outcome: raw ? JSON.parse(Buffer.from(raw, 'base64').toString()) : null, tx: r.transaction?.hash };
    },
  };
}
