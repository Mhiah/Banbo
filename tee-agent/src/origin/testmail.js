// Test and demo mail ONLY: DKIM-signed messages from made-up domains and a
// stand-in DNS resolver that serves their keys. Real deployments resolve real
// DNS (emailDocument without a resolver); never use this resolver there.
import crypto from 'node:crypto';
import { dkimSign } from 'mailauth';

const keys = new Map(); // domain -> { pem, pub }
function domainKey(domain) {
  if (!keys.has(domain)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    keys.set(domain, {
      pem: privateKey.export({ type: 'pkcs1', format: 'pem' }),
      pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    });
  }
  return keys.get(domain);
}

export const resolver = async (name, type) => {
  const m = /^s1\._domainkey\.(.+)$/.exec(name);
  if (type === 'TXT' && m && keys.has(m[1])) return [[`v=DKIM1; k=rsa; p=${keys.get(m[1]).pub}`]];
  const e = new Error(`no record for ${name}`);
  e.code = 'ENOTFOUND';
  throw e;
};

export function mail({ from, subject, body }) {
  return [
    `From: ${from}`, 'To: ap@company.example', `Subject: ${subject}`,
    'Date: Mon, 2 Nov 2026 10:00:00 +0000', `Message-ID: <${crypto.randomUUID()}@x>`, '', body, '',
  ].join('\r\n');
}

export async function signed(domain, msg) {
  const k = domainKey(domain);
  const s = await dkimSign(msg, { canonicalization: 'relaxed/relaxed', signatureData: [{ signingDomain: domain, selector: 's1', privateKey: k.pem }] });
  if (s.errors.length) throw new Error(`signing failed: ${s.errors[0].err?.message}`);
  return s.signatures + msg;
}
