# Origin-checked payments

Banbo pays only when it knows where a payment's recipient and amount came from.

This builds on **CaMeL**, from *"Defeating Prompt Injections by Design"* by Edoardo Debenedetti, Ilia Shumailov, Tianqi Fan, Jamie Hayes, Nicholas Carlini, Daniel Fabian, Christoph Kern, Chongyang Shi, Andreas Terzis and Florian Tramèr (Google, Google DeepMind and ETH Zurich, 2025), [arXiv:2503.18813](https://arxiv.org/abs/2503.18813). The design is theirs. Banbo's contribution is enforcing its policy in a smart contract that holds the money, with the labels backed by an on-chain TEE attestation. Banbo is not affiliated with the authors or their institutions.

## The attack limits don't stop

A spending firewall with limits and an allowlist stops an agent from paying a stranger. It does not stop invoice fraud. A forged email says *"Acme's invoice is now 0.45"* or *"pay Globex this month instead of Acme."* Both vendors are approved and the amount is under every limit, so the payment goes through. The question that catches this is not *"is this recipient allowed?"* but *"where did this recipient and this amount come from?"*

## CaMeL in one paragraph

A **privileged planner** sees only the user's request and writes a plan. A **quarantined reader** reads untrusted content and returns data in a fixed shape. It has no tools and cannot change the plan. An **interpreter** runs the plan and gives every value a *capability*, a label saying where it came from. Before any action, a policy checks the labels. A successful injection can change what the reader returns, but not the plan, and not the labels. On the AgentDojo benchmark CaMeL completed 77% of tasks with provable security, against 84% for an undefended agent.

## What Banbo changes

In CaMeL the policy runs on the same machine as the agent. Banbo moves the policy into the vault contract, which holds the funds:

| | CaMeL | Banbo |
|---|---|---|
| Policy check | In the agent's interpreter | In the NEAR contract, on every payment |
| Who can turn it off | Whoever controls the agent's machine | Nobody: it is the contract's code (reproducible build) |
| Why the labels are believed | The interpreter is your own code | The interpreter runs in an Intel TDX TEE whose quote the contract verifies on-chain (or the owner explicitly vouches, recorded per payment) |
| Owner's intent | The user's prompt | Also an on-chain **task**: payees, budget, per-payment cap, end time, trusted sources |

## The rule

The owner opens a **task** for an agent:

```
create_task(id, agent, description, payees[], token, budget, max_per_payment, trusted_sources[], expires_at_ms)
```

A payment under a task carries labels:

```json
{ "task_id": "acme-oct",
  "recipient": { "kind": "owner" },
  "amount":    { "kind": "source", "source": "email:acme.com", "digest": "<sha256 of the email>" } }
```

The contract decides, in this order:

1. The labels are only accepted from an agent with a valid TDX attestation for an approved measurement, or one the owner vouches for (`label_trust` records `tee` or `owner_vouched`).
2. The task must exist, belong to this agent, be open, not expired, and be in the same asset.
3. **The recipient must be owner-origin.** A recipient that came from any document is refused (`recipient_from_untrusted_source`).
4. **The recipient must be one of the task's payees.** The contract checks this list itself, so even a mislabelled recipient can't leave the task (`recipient_not_in_task`).
5. The amount must fit the task's per-payment cap and remaining budget.
6. **An amount from a source the task doesn't trust is held for the owner** (`amount_from_untrusted_source`), with the source and the content's sha256 on the request, so the owner can find the exact message.
7. Every ordinary rule still applies: allowlist, cooldown, per-agent and shared limits, rate limit, approval threshold, vault balance.

Refusals go to the bounded blocked log with their labels. With `set_origin_policy(true)`, unlabelled payments are refused altogether.

## Sources

The runtime labels each document before the reader sees it:

- **email:<domain>**: the message has a DKIM signature that verifies, and its signing domain matches the From address. Anything else is `email:unverified`, and the contract won't let an owner trust that.
- **web:<host>**: an https page; TLS vouches for the host.
- **doc:<name>**: a file handed to the agent.

## The runtime

`tee-agent/src/origin/`:

- `planner.js`: the privileged planner. Its whole input is the owner's request and the on-chain task. Documents appear only as ids (`d1 (email)`), so no document text can reach it. Constants in its plan are therefore owner-origin.
- `plan.js`: the plan language: `extract` fields of a type (`decimal`, `account`, `text`) from a document, and `pay`. Plans are validated strictly before they run.
- `reader.js`: the quarantined reader. One document in, typed fields out, each labelled with the document's source.
- `interpreter.js`: runs the plan, keeps labels, sends each payment with its labels, and writes the summary from the trace rather than with a model, so a document can't put words in the report.
- `sources.js`: DKIM-checked email, web pages and files.

The TEE agent exposes it as `POST /origin-task` with `{task_id, request, emails, urls}`.

## Limits

- The labels are as trustworthy as the TEE and the runtime code. The on-chain quote check, the approved measurement and the reproducible builds make that checkable. Owner-vouched labels are weaker and are recorded as such.
- Like CaMeL, this trades some automation for safety: an amount from a new or untrusted source waits for the owner.
- The planner must receive the owner's own words. If an owner pastes an email into the request, its text becomes owner-origin. Forward documents as documents.
- Amounts and recipients of payments that are made are public on NEAR, as on any public chain.
