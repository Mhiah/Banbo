# Banbo TEE agent

A Banbo agent that runs inside an Intel TDX confidential VM (managed by
[dstack](https://github.com/Dstack-TEE/dstack), the stack under Phala Cloud
and NEAR AI's TEE infrastructure). Nobody, including whoever hosts it, can read
its NEAR key, its prompts, the invoices it reads or the memos it writes.

It proves this to the vault itself: the vault contract verifies the VM's
Intel TDX quote on-chain and only then lets the agent spend (when the owner
turns on **Require TEE agents**).

| | How |
|---|---|
| **Key** | Derived by dstack's key service, which only releases it to a VM of this app with matching measurements. The agent's NEAR account is the implicit account of that key, so no other key controls it. |
| **Attestation** | A fresh TDX quote whose `report_data` is the agent's account, plus Intel collateral and the VM's event log, sent to `attest_agent`. The contract checks Intel's signatures, the TCB status, that `report_data` is the caller, replays RTMR3, and matches the firmware, OS and app compose hash against what the owner approved. About 189 Tgas. Re-attests at half the attestation lifetime. |
| **Thinking** | NEAR AI Cloud private inference (OpenAI-compatible API; the models run in TEEs), so the prompt never leaves confidential hardware. |
| **Memos** | Always sealed to the owner's key by the runtime before the transaction is built. |
| **Hidden vendors** | Their salts come from an encrypted environment variable. The model only ever names a recipient; the runtime adds the salt. |

## Deploy

You need: a Banbo vault on testnet (or mainnet), a NEAR AI Cloud API key, and
an account on a dstack host such as Phala Cloud.

1. **Build and publish the image**, then pin it by digest in
   `docker-compose.yml`:
   ```sh
   docker build -t ghcr.io/<you>/banbo-tee-agent:0.1.0 .
   docker push ghcr.io/<you>/banbo-tee-agent:0.1.0   # note the sha256 digest
   ```
2. **Deploy `docker-compose.yml`** on the dstack host. Set these as
   encrypted secrets (they don't change the measurement):
   `NEAR_NETWORK`, `VAULT_ID`, `NEAR_AI_API_KEY`, `NEAR_AI_MODEL`,
   `AGENT_TASK_TOKEN` (any long random string), `HIDDEN_VENDORS` (copied
   from the dashboard's Privacy page, e.g. `{"vendor.near":"<salt>"}`).
3. **Read the logs** (or `GET /status`). The agent prints its account (64 hex
   characters) and its measurement JSON.
4. **In the dashboard, Privacy page:** *Approve an image* and paste the
   measurement. Before approving, check that `compose_hash` is the hash of the
   compose file you deployed.
5. **Agents page:** register the agent's account with its limits. Send it
   about 0.5 NEAR for gas (it never holds treasury funds).
6. The agent attests on its own within a minute. Its badge turns to **TEE**.
7. **Privacy page:** turn on **Require TEE agents**. From now on, only
   attested agents running your approved image can spend.

Give it work:

```sh
curl -X POST https://<agent-host>/task -H "authorization: Bearer $AGENT_TASK_TOKEN" \
  -d '{"task":"Buy a 3-day forecast for Lisbon from https://<paid-api>/v1/forecast?city=Lisbon"}'
```

## Verify it yourself

`GET /attestation` returns the latest quote and measurement. Anyone can check
the quote with Intel DCAP tooling (for example `@phala/dcap-qvl`) and compare
the compose hash to this repository's compose file. The vault's
`get_agent_tee` view shows what the contract accepted and until when.

## Limits

- Trust in the TEE is trust in Intel TDX and in dstack's key service. A
  hardware vulnerability or a compromised key service would break the
  privacy guarantees (not the spending limits, which the contract enforces
  regardless).
- An attestation proves what code started. The vault re-checks it only when
  the agent re-attests, which is why attestations expire.
- Payments themselves (amount, recipient, time) are public on NEAR.

## Tests

```sh
npm ci && npm test        # unit tests, including the genuine Intel sample quote
cd ../demo && npm test    # includes this runtime attesting and paying against a local node
```
