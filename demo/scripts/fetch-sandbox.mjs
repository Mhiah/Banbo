// near-workspaces ships an older sandbox node that lacks host functions
// current near-sdk links against. Swap in nearcore 2.14.0 after install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const VERSION = process.env.NEAR_SANDBOX_VERSION || '2.14.0';
const platform = os.type() === 'Darwin' ? 'Darwin-arm64' : 'Linux-x86_64';
const url = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${platform}/${VERSION}/near-sandbox.tar.gz`;

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('near-sandbox/package.json'));
const target = path.join(pkgDir, 'bin', 'near-sandbox');
const stamp = `${target}.version`;
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === VERSION) process.exit(0);

console.log(`Fetching NEAR sandbox ${VERSION} (${platform})...`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'near-sandbox-'));
const tgz = path.join(tmp, 'sandbox.tar.gz');
const res = await fetch(url);
if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
execFileSync('tar', ['xzf', tgz, '-C', tmp]);
fs.mkdirSync(path.dirname(target), { recursive: true });
// Copy then rename, so a running old binary doesn't block the swap.
fs.copyFileSync(path.join(tmp, platform, 'near-sandbox'), `${target}.new`);
fs.chmodSync(`${target}.new`, 0o755);
fs.renameSync(`${target}.new`, target);
fs.writeFileSync(stamp, VERSION);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`NEAR sandbox ${VERSION} installed.`);
