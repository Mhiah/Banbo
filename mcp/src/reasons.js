// What the vault's answers mean, in words an agent (and the person reading
// its transcript) can act on. Codes come from the Banbo contract.
export const REASONS = {
  vault_paused: 'The owner has paused the vault. No payments go out until they unpause it.',
  unknown_agent: 'This account is not registered as an agent of the vault.',
  agent_disabled: 'The owner has disabled this agent.',
  zero_amount: 'The amount must be more than zero.',
  recipient_not_allowlisted: 'The recipient is not on the owner\'s list of approved recipients.',
  recipient_not_allowed: 'The recipient is not on the owner\'s list of approved recipients.',
  recipient_in_cooldown: 'The recipient was approved recently and is still in its cooling-off period.',
  exceeds_per_request_max: 'The amount is over this agent\'s limit for a single payment.',
  exceeds_agent_period_limit: 'This payment would take the agent over its daily limit.',
  exceeds_shared_cap: 'This payment would take the vault over its shared daily limit.',
  exceeds_payment_rate: 'The agent has made too many payments in the last hour.',
  insufficient_vault_balance: 'The vault does not have enough free balance for this payment.',
  too_many_open_payments: 'Too many payments are waiting for approval or confirmation.',
  token_not_supported: 'The vault does not accept this token.',
  token_not_enabled_for_agent: 'This agent has no limits set for this token, so it cannot pay in it.',
  memo_not_encrypted: 'The vault only accepts encrypted memos.',
  agent_not_attested: 'The vault only accepts this from an attested (TEE) agent, or one the owner vouches for.',
  attestation_expired: 'This agent\'s TEE attestation has expired.',
  agent_measurement_not_approved: 'This agent runs a TEE image the owner no longer approves.',
  origin_required: 'The owner requires every payment to carry origin labels. Use banbo_pay_invoice under a task mandate.',
  task_not_found: 'There is no task mandate with that id.',
  task_not_for_agent: 'That mandate belongs to another agent.',
  task_closed: 'The owner has closed that mandate.',
  task_expired: 'That mandate has ended.',
  task_token_mismatch: 'That mandate pays in a different token.',
  recipient_from_untrusted_source: 'Under a task mandate the recipient must come from the owner, not from a document.',
  recipient_not_in_task: 'The recipient is not one of the mandate\'s payees.',
  exceeds_task_max_per_payment: 'The amount is over the mandate\'s limit for a single payment.',
  exceeds_task_budget: 'This payment would take the mandate over its budget.',
  amount_from_untrusted_source: 'The amount came from a sender the owner has not marked as trusted for this mandate.',
  over_approval_threshold: 'The amount is over this agent\'s approval threshold.',
};

export const explain = (code) => (code ? REASONS[code] ?? code : '');

/** A request's status, in words. */
export const STATUS = {
  PendingApproval: 'waiting for the owner to approve or decline it',
  InFlight: 'sent; the network has not confirmed the transfer yet',
  Settled: 'paid; the network confirmed the transfer',
  Failed: 'failed on-chain; the transfer did not go through, the reservation was released and the funds are back in the vault',
  Declined: 'declined by the owner; nothing was sent',
  Expired: 'expired without approval; nothing was sent',
};
