# Private mode

Banbo runs on a public chain. Without private mode, anyone can read a vault's
allowlist (your vendor list), every payment memo, and every agent's activity.
Private mode keeps what can be kept private to the owner, and is plain about
what can't.

## What private mode adds

### 1. Hidden vendors

A vendor on the hidden allowlist is stored on-chain only as

```
fingerprint = sha256("banbo-recipient-v1:" + account + ":" + salt)
```

with a random 32-byte salt per vendor. With a 256-bit salt, the fingerprint
can't be reversed or brute-forced from a list of known accounts. The owner's
dashboard keeps a label next to it, encrypted to the owner's key, so the owner
sees names and nobody else does.

To pay a hidden vendor the agent passes its salt in `request_payment`. The
contract recomputes the fingerprint from the recipient and salt, so a salt only
works for its own vendor: an agent tricked into reusing it for another account
is refused. The salts sit in the agent runtime's (encrypted) config. The model
only names a recipient; the runtime adds the salt.

### 2. Encrypted memos

The owner sets an X25519 public key on the vault. Agents seal every memo to it
(NaCl box with a fresh key per memo) before the transaction is built, so the
chain stores ciphertext only. The dashboard opens memos after the owner
unlocks private mode, either by signing a fixed message with their wallet
(NEP-413, no transaction) or with a passphrase. The key is derived on the
device and kept in memory only.

With **Refuse plaintext memos** on, the contract rejects a payment whose memo
isn't ciphertext, and doesn't copy that memo into its records or logs.

### 3. TEE agents

A private agent runs in an Intel TDX confidential VM (dstack, as used by
NEAR AI Cloud and Phala Cloud). Its NEAR key is created inside the VM; its
account is that key's implicit account. It thinks with NEAR AI Cloud private
inference, so prompts and documents stay in confidential hardware.

The vault contract verifies the agent's TDX quote itself (`attest_agent`):
Intel's signature chain and collateral, the TCB status, that the quote's
`report_data` is the calling account, the RTMR3 event log, and that the
firmware, OS and app compose hash match a measurement the owner approved.
This costs about 189 Tgas. Attestations expire (7 days by default) and can be
revoked; removing an approved image cuts off every agent running it. With
**Require TEE agents** on, only attested agents can spend.

See [`tee-agent/`](../tee-agent) for the runtime and deploy guide.

## What stays public

- **Payments that are made.** Amount, token, recipient and time of every
  transfer are public on NEAR. A hidden vendor stops being hidden once it is
  paid, because the payment names it.
- **That rules exist.** The number of hidden vendors, when each was added,
  your limits, risk rules and TEE policy are readable by anyone.
- **The agent's own transactions.** Their arguments are public. That's why
  memos are sealed by the runtime before sending, and why a refused plaintext
  memo is still visible in the refused transaction itself.
- **No zero-knowledge proofs.** Privacy comes from encryption, salted
  fingerprints and TEEs. Nothing here hides transfers.

## Trust assumptions

- **Spending limits never depend on privacy.** Every rule is enforced by the
  contract whether or not private mode is on.
- **TEE privacy trusts Intel TDX and dstack's key service.** A hardware flaw or
  a compromised key service would expose a TEE agent's secrets. It would not
  let anyone exceed the vault's limits or pay a recipient that isn't allowed.
- **An attestation proves what started.** The contract re-checks only when the
  agent re-attests, hence the expiry.
- **The owner's key.** Anyone with the owner's wallet key (or passphrase) can
  derive the private-mode key. Different access keys on the same account derive
  different private-mode keys, so unlock with the one you set it up with.

## Confidential Intents: feasibility

NEAR's Confidential Intents (generally available, mainnet only) moves funds
through a private shard so that a deposit and its withdrawal can't be linked,
and keeps amounts and counterparties off the public chain while inside. Apps
use it through the 1Click API by adding `"confidentiality": "basic"` (or
`"advanced"`) to a quote request, or by holding funds in a Confidential
Intents balance (`depositType` / `recipientType` = `CONFIDENTIAL_INTENTS`).

We checked whether a vault could pay vendors through it:

| Question | Finding |
|---|---|
| Can the vault start a confidential payment? | Yes in principle: it would `ft_transfer` USDC to the per-quote deposit address 1Click returns. |
| Can the contract enforce *who* gets paid? | **No.** The final recipient is set in the off-chain quote request. The deposit address doesn't reveal it, and the 1Click quote signature isn't documented in a form a contract can verify. |
| Testnet? | None. NEAR Intents is mainnet only. |

**Decision:** agent payouts stay on public, contract-enforced transfers.
Routing them through Confidential Intents would let a compromised agent request
a quote to any address and have the vault pay it, which is the exact attack
Banbo exists to stop. Confidential Intents still fits the owner's side: funding
the vault or moving treasury funds privately, which doesn't go through an
agent. If 1Click publishes a verifiable signed quote that binds the recipient,
the contract could check that signature and the recipient against the
allowlist before paying the deposit address. That's the path to confidential
agent payouts.

`scripts/confidential-intents-check.mjs` asks the live 1Click API for a dry
confidential quote (no funds move) for a USDC payment on NEAR. The findings
above come from the published API reference and OpenAPI spec; run the script
to confirm them against the live service.
