// Turning untrusted inputs into documents with a source label.
//
// email: the source is "email:<domain>" only when the message carries a DKIM
//   signature that verifies and whose domain matches the From domain (the
//   sender's domain vouched for the exact bytes). Anything else is
//   "email:unverified", which the contract refuses to let an owner trust.
// web: the source is "web:<host>" for an https page (TLS vouches for the host).
// doc: a file handed to the agent, labelled "doc:<name>".
import { dkimVerify } from 'mailauth';
import { fromSource } from './labels.js';

const MAX_DOC = 200_000;

function splitMessage(raw) {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i < 0 ? raw : raw.slice(0, i);
  const body = i < 0 ? '' : raw.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] ??= m[2];
  }
  return { headers, body };
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

/**
 * An email document. `resolver` is a DNS TXT resolver for DKIM keys; the
 * default is real DNS. Returns { kind, source, label, text, from, verified }.
 */
export async function emailDocument(raw, { resolver } = {}) {
  if (raw.length > MAX_DOC) throw new Error('email too large');
  const { headers, body } = splitMessage(raw);
  const fromDomain = addressDomain(headers.from);
  let verified = null;
  try {
    const r = await dkimVerify(raw, resolver ? { resolver } : {});
    const ok = (r.results ?? []).find((x) => x.status?.result === 'pass' && x.signingDomain && fromDomain
      && (fromDomain === x.signingDomain.toLowerCase() || fromDomain.endsWith(`.${x.signingDomain.toLowerCase()}`)));
    verified = ok ? ok.signingDomain.toLowerCase() : null;
  } catch {
    verified = null;
  }
  const source = verified ? `email:${verified}` : 'email:unverified';
  const subject = headers.subject ?? '';
  return {
    kind: 'email',
    source,
    label: fromSource(source, raw),
    from: headers.from ?? '',
    verified: Boolean(verified),
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
  const html = (await r.text()).slice(0, MAX_DOC);
  const source = `web:${u.hostname.toLowerCase()}`;
  return { kind: 'web', source, label: fromSource(source, html), from: u.hostname, verified: !local, text: htmlToText(html).slice(0, 20_000) };
}

/** Any other file, e.g. a PDF's text the owner forwarded. */
export function fileDocument(name, content) {
  const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'file';
  const source = `doc:${safe}`;
  return { kind: 'doc', source, label: fromSource(source, content), from: safe, verified: false, text: String(content).slice(0, 20_000) };
}
