# Banbo MCP server

Lets any AI agent that speaks the [Model Context Protocol](https://modelcontextprotocol.io) (Claude Desktop, Claude Code, Cursor, a NEAR AI agent) pay through a Banbo vault. The agent never holds the treasury: the server holds only the agent's **function-call key**, which can call nothing but `request_payment` on the vault, and the vault contract decides every payment.

## Tools

| Tool | What it does |
|---|---|
| `banbo_status` | The agent's limits, what it has spent and has left this period, payments made this hour, whether the vault is paused, and whether the vault accepts this agent's origin labels. Read-only. |
| `banbo_list_mandates` | The open task mandates the owner gave this agent: payees, budget left, largest single payment, which email senders are trusted to set an amount. Read-only. |
| `banbo_pay` | Pay an approved recipient in NEAR or a token the vault accepts (e.g. USDC). The contract applies the allowlist, limits, approval threshold, cooldowns and rate limit. |
| `banbo_pay_invoice` | Pay an emailed invoice under a task mandate, with origin labels the server works out itself (below). |
| `banbo_payment_status` | Paid, waiting for the owner, failed and refunded, declined, expired, or refused. Read-only. |

Every answer says what the contract did, in words: "Paid … The network confirmed the transfer", "Held for the owner: …", or "Refused by the vault contract: … Nothing was paid." A payment is called paid only after the network has confirmed it. Reusing a `request_id` never pays twice.

## Origin labels the model can't fake

[Origin-checked payments](../docs/ORIGIN_CHECKS.md) only work if the labels are honest, so **no tool lets the model set a label**. For `banbo_pay_invoice` the model passes the mandate, the complete raw email and the amount, and the server labels them:

- **Amount:** the server checks the email's DKIM signature itself. The amount is labelled `email:<domain>` only if the signature verifies and its domain matches the From address; otherwise `email:unverified`. The amount must be written in the email, or nothing is sent.
- **Recipient:** labelled as the owner's only if the owner listed it as one of the mandate's payees. Anything else is labelled as coming from the email, and the contract refuses it.

A forged "corrected invoice" from a lookalike domain is therefore held for the owner with the email's sha256, and a "pay our partner instead" redirect is refused, whatever the model was talked into.

Limits of this check: it proves which domain sent the email and that the amount is written in it, not which number on the invoice is the total. The mandate's per-payment cap and budget bound the damage. The vault accepts these labels only from an agent the owner vouches for (`set_label_vouch`) or one with an Intel TDX attestation; the server runs on the owner's or operator's machine, so vouching for it means trusting that machine.

## Setup

Needs Node 20+ and a vault where the owner has added this agent (`add_agent`) and approved its recipients. From the repo root:

```bash
make setup     # installs mcp/ and tee-agent/ (the server reuses the DKIM and label code)
```

**1. Give the agent a function-call key** that can only call `request_payment` on the vault. With [near-cli-rs](https://github.com/near/near-cli-rs), signed by the agent account:

```bash
near account add-key agent.you.testnet grant-function-call-access --allowance '1 NEAR' \
  --contract-account-id vault.you.testnet --function-names 'request_payment' \
  autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-keychain send
```

This saves the new key as a JSON file under `~/.near-credentials/testnet/`; point `BANBO_CREDENTIALS_FILE` at that file. The allowance pays for gas only: each payment uses up to 100 Tgas of it (about 0.01 NEAR at the minimum gas price), so 1 NEAR covers roughly 100 payments. When it runs out the server says so; add a new key the same way. The server refuses to start with a full-access key.

**2. For invoice payments**, the owner vouches for this agent's labels (on the dashboard's Mandates page, or `set_label_vouch`) and creates a task mandate for it.

**3. Add the server to your MCP client.** For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "banbo": {
      "command": "node",
      "args": ["/path/to/Banbo/mcp/src/index.js"],
      "env": {
        "BANBO_NETWORK": "testnet",
        "BANBO_VAULT": "vault.you.testnet",
        "BANBO_AGENT_ACCOUNT": "agent.you.testnet",
        "BANBO_CREDENTIALS_FILE": "/home/you/.near-credentials/testnet/agent.you.testnet/<key file>.json"
      }
    }
  }
}
```

For Claude Code: `claude mcp add banbo --env BANBO_VAULT=… --env BANBO_AGENT_ACCOUNT=… --env BANBO_CREDENTIALS_FILE=… -- node /path/to/Banbo/mcp/src/index.js`.

| Variable | |
|---|---|
| `BANBO_VAULT` | the vault contract account (required) |
| `BANBO_AGENT_ACCOUNT` | the agent's account (required) |
| `BANBO_CREDENTIALS_FILE` | a near-cli credentials JSON holding the function-call key (`private_key`) |
| `BANBO_AGENT_KEY` | or the key itself, `ed25519:…` |
| `BANBO_NETWORK` | `testnet` (default) or `mainnet` |
| `BANBO_RPC` | RPC URL, or several separated by commas (the first that answers is used). Defaults to public FastNEAR and NEAR nodes for the network |
| `BANBO_RECIPIENT_SALTS` | JSON `{"vendor.near": "<salt>"}` for [hidden vendors](../docs/PRIVACY.md); comes from your config, never from the model |
| `BANBO_ALLOW_FULL_ACCESS_KEY` | `1` accepts a full-access key. Local testing only. |

Memos are encrypted to the owner automatically when the vault has an encryption key. The server logs to stderr; stdout carries the protocol.

## Tests

```bash
cd mcp && npm test          # 17 unit tests: amounts, key checks, labels, refusals, wording
make test-sandbox           # includes 7 end-to-end tests against the real contract on a local NEAR node
```

The end-to-end tests run the server over stdio with a real function-call key: a full-access key is refused at startup, NEAR and USDC payments are paid and confirmed, a payment to an attacker is refused, a retry pays nothing more, and invoice payments under a task mandate are paid, held or refused with the labels recorded on-chain.
