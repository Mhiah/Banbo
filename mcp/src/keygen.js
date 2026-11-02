// `banbo-mcp keygen [file]`: make the agent's key on the machine that runs
// the agent. The private key is written to a file only this user can read
// and never leaves the machine; you paste the printed PUBLIC key into the
// dashboard's "Connect an agent" screen, which installs it as a key that can
// only call request_payment on your vault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from 'near-api-js';

export function keygen(file = path.join(os.homedir(), '.banbo', 'agent-key.json')) {
  if (fs.existsSync(file)) throw new Error(`${file} already exists; not overwriting it. Pass another path, or delete it first.`);
  const kp = KeyPair.fromRandom('ed25519');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ public_key: kp.getPublicKey().toString(), private_key: kp.toString() }, null, 2) + '\n';
  fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
  return { file, publicKey: kp.getPublicKey().toString() };
}
