// The agent's connection to its vault. The only transaction it can sign is
// request_payment on that vault; everything else is a read.
import { connect, keyStores } from 'near-api-js';
import { seal } from '../../tee-agent/src/privacy.js';

const TGAS = (n) => BigInt(n) * 10n ** 12n;
// request_payment uses at most about 29 Tgas itself (when it also expires
// ten overdue approvals) and attaches 45 Tgas to a USDC transfer and its
// callbacks; 100 Tgas covers both. Every call is charged against the key's
// allowance at the full prepaid gas, so this is kept no larger than needed.
const PAYMENT_GAS = TGAS(100);

/**
 * Check the key before using it. A full-access key could move the agent's
 * own NEAR or call anything, so the server refuses it unless explicitly told
 * otherwise (local testing only).
 */
export function checkAccessKey(permission, vaultId, { allowFullAccess = false } = {}) {
  if (permission === 'FullAccess') {
    if (allowFullAccess) return 'full-access key (allowed by BANBO_ALLOW_FULL_ACCESS_KEY; for local testing only)';
    throw new Error('this is a full-access key. Give the server a function-call key that can only call request_payment on the vault (see mcp/README.md)');
  }
  const fc = permission?.FunctionCall;
  if (!fc) throw new Error('unrecognised access key permission');
  if (fc.receiver_id !== vaultId) throw new Error(`this key is for ${fc.receiver_id}, not the vault ${vaultId}`);
  if (fc.method_names.length && !fc.method_names.includes('request_payment')) {
    throw new Error('this key cannot call request_payment');
  }
  return `function-call key for ${vaultId} (${fc.method_names.length ? fc.method_names.join(', ') : 'any method'})`;
}

export async function openVault({ networkId, nodeUrl, vaultId, accountId, keyPair, allowFullAccess = false }) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(networkId, accountId, keyPair);
  const near = await connect({ networkId, nodeUrl, keyStore });
  const account = await near.account(accountId);
  const view = (method, args = {}) => account.viewFunction({ contractId: vaultId, methodName: method, args });

  const key = await near.connection.provider.query({
    request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: keyPair.getPublicKey().toString(),
  });
  const keyInfo = checkAccessKey(key.permission, vaultId, { allowFullAccess });

  return {
    accountId,
    vaultId,
    networkId,
    keyInfo,
    view,
    /** Returns the contract's RequestOutcome and the transaction hash. */
    async requestPayment({ requestId, recipient, amount, token = null, memo = '', recipientSalt = null, origin = null }) {
      const cfg = await view('get_config');
      const sealed = memo && cfg.owner_encryption_key ? seal(memo, cfg.owner_encryption_key) : memo;
      let r;
      try {
        r = await account.functionCall({
          contractId: vaultId,
          methodName: 'request_payment',
          args: { request_id: requestId, recipient, amount, memo: sealed || null, token, recipient_salt: recipientSalt, origin },
          gas: PAYMENT_GAS,
        });
      } catch (e) {
        if (/does not have enough balance/.test(e.message)) {
          throw new Error('the agent key has used up its gas allowance. The owner of the agent account needs to add a new function-call key (see mcp/README.md)');
        }
        throw e;
      }
      const raw = r.status?.SuccessValue;
      return { outcome: raw ? JSON.parse(Buffer.from(raw, 'base64').toString()) : null, tx: r.transaction?.hash ?? r.transaction_outcome?.id };
    },
  };
}
