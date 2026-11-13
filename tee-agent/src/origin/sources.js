// Turning untrusted inputs into documents with a source label.
//
// email: the source is "email:<domain>" only when the message carries a DKIM
//   signature that verifies and whose domain matches the From domain (the
//   sender's domain vouched for the exact bytes). Anything else is
//   "email:unverified", which the contract refuses to let an owner trust.
//   Only what that signature covers is vouched for, so a message also counts
//   as unverified when it has a From, Subject or MIME header the signature
//   does not cover (someone can add one to a genuine message), or when the
//   signature covers only part of the body (the l= tag).
// web: the source is "web:<host>" for an https page (TLS vouches for the
//   host), where the host is the one that actually served the page after
//   any redirects.
// doc: a file handed to the agent, labelled "doc:<name>".
import { dkimVerify } from 'mailauth';
import { fromSource, sha256 } from './labels.js';

const MAX_DOC = 200_000;

function splitMessage(raw) {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i < 0 ? raw : raw.slice(0, i);
  const body = i < 0 ? '' : raw.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  const counts = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase();
    headers[name] ??= m[2];
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return { headers, body, counts };
}

function decodeBody(headers, body) {
  const ct = headers['content-type'] ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
  if (/^multipart\//i.test(ct) && boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const p = splitMessage(part.replace(/^\r?\n/, ''));
      if (/^text\/plain/i.test(p.headers['content-type'] ?? 'text/plain') && p.body.trim()) return decodeBody(p.headers, p.body);
    }
    return '';
  }
  const enc = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    return body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

const addressDomain = (from) => /@([A-Za-z0-9.-]+)>?\s*$/.exec(from ?? '')?.[1]?.toLowerCase() ?? null;

/** How many instances of each header a DKIM signature covers (its h= list). */
function signedCounts(result) {
  const out = {};
  for (const name of String(result.signingHeaders?.keys ?? '').split(':')) {
    const n = name.trim().toLowerCase();
    if (n) out[n] = (out[n] ?? 0) + 1;
  }
  return out;
}

/**
 * Does this passing signature vouch for everything the document is built
 * from? DKIM checks the headers named in h=, from the bottom up, and the
 * body. A header added on top of a genuine message is not covered, and with
 * an l= tag neither is anything appended to the body.
 */
function coversDocument(result, counts) {
  if (result.canonBodyLengthLimited) return false;
  const signed = signedCounts(result);
  // Exactly one From, and it is signed.
  if (counts.from !== 1 || !signed.from) return false;
  // Every Subject present is signed (an unsigned Subject is left out below).
  if (signed.subject && (counts.subject ?? 0) > signed.subject) return false;
  // MIME headers decide how the signed body is read. Many senders don't sign
  // them, so one unsigned instance is accepted; a second one is not.
  for (const h of ['content-type', 'content-transfer-encoding']) {
    if ((counts[h] ?? 0) > Math.max(signed[h] ?? 0, 1)) return false;
  }
  return true;
}

/**
 * An email document. `resolver` is a DNS TXT resolver for DKIM keys; the
 * default is real DNS. Returns { kind, source, label, text, from, verified,
 * identity }. `identity` is the same for every copy of one signed message
 * (it is taken from the DKIM signature), so a payment can be tied to the
 * invoice and not to the bytes of one copy.
 */
export async function emailDocument(raw, { resolver } = {}) {
  if (raw.length > MAX_DOC) throw new Error('email too large');
  const { headers, body, counts } = splitMessage(raw);
  const fromDomain = addressDomain(headers.from);
  let verified = null;
  let ok = null;
  try {
    const r = await dkimVerify(raw, resolver ? { resolver } : {});
    ok = (r.results ?? []).find((x) => x.status?.result === 'pass' && x.signingDomain && fromDomain
      && (fromDomain === x.signingDomain.toLowerCase() || fromDomain.endsWith(`.${x.signingDomain.toLowerCase()}`))
      && coversDocument(x, counts)) ?? null;
    verified = ok ? ok.signingDomain.toLowerCase() : null;
  } catch {
    verified = null;
  }
  const source = verified ? `email:${verified}` : 'email:unverified';
  // A Subject the signature doesn't cover is not the sender's word.
  const subject = verified && !signedCounts(ok).subject ? '' : headers.subject ?? '';
  const identity = verified ? sha256(`dkim:${verified}:${ok.selector ?? ''}:${ok.signature}`) : sha256(raw);
  return {
    kind: 'email',
    source,
    label: fromSource(source, raw, identity),
    from: headers.from ?? '',
    verified: Boolean(verified),
    identity,
    text: `Subject: ${subject}\nFrom: ${headers.from ?? ''}\n\n${decodeBody(headers, body)}`.slice(0, 20_000),
  };
}
const htmlToText = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();

/** A web page, labelled with its host. Comments stay in the text: injections hide there. */
export async function webDocument(url, { fetchImpl = fetch } = {}) {
  const u = new URL(url);
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('only https pages');
  const r = await fetchImpl(url);
  // After a redirect the page belongs to the host that served it, not the
  // host that was asked.
  const served = r.url ? new URL(r.url) : u;
  const servedLocal = served.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(served.hostname);
  if (served.protocol !== 'https:' && !servedLocal) throw new Error('only https pages');
  const html = (await r.text()).slice(0, MAX_DOC);
  const source = `web:${served.hostname.toLowerCase()}`;
  return { kind: 'web', source, label: fromSource(source, html), from: served.hostname, verified: !servedLocal, text: htmlToText(html).slice(0, 20_000) };
}

/** Any other file, e.g. a PDF's text the owner forwarded. */
export function fileDocument(name, content) {
  const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'file';
  const source = `doc:${safe}`;
  return { kind: 'doc', source, label: fromSource(source, content), from: safe, verified: false, text: String(content).slice(0, 20_000) };
}
