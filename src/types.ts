// x402 protocol types (HTTP 402 "Payment Required" for agent payments).

export type Network = "solana" | "base" | (string & {});

export interface Authorization {
  from: string;
  to: string;
  value: string; // atomic units (USDC = 6 decimals)
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: "exact" | (string & {});
  network: Network;
  payload: { signature: string; authorization: Authorization };
  extra?: Record<string, unknown>;
}

export interface PaymentRequirements {
  scheme: "exact" | (string & {});
  network: Network;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}

/**
 * How strong a settlement a facilitator is claiming.
 *
 * `success: true` says a transaction exists. It does not say the transaction is
 * irreversible, and those are different facts — on Solana they are roughly
 * 400ms and 12.8 seconds apart. A gate that cannot tell them apart releases
 * goods against the first number while believing it has the second.
 *
 * Ordered weakest to strongest; `gate()` compares against a required minimum.
 */
export type SettlementStrength =
  /** The facilitator reported nothing about strength. Assume the weakest. */
  | "unknown"
  /** Broadcast to the network, not yet observed in a block. */
  | "submitted"
  /** In a block and optimistically confirmed. Fast, and revocable by a re-org. */
  | "confirmed"
  /** Irreversible. */
  | "finalized";

/**
 * Settlement evidence, when the facilitator supplies it.
 *
 * Optional in full: a facilitator that reports nothing here is not lying, it is
 * simply not answering, and the answer is then treated as `unknown` rather than
 * inferred from `success`.
 */
export interface SettlementEvidence {
  strength: SettlementStrength;
  /** Confirmations behind the transaction. `null` means rooted. */
  confirmations?: number | null;
  /** Slot or block number the transaction landed in. */
  slot?: number;
  /** ISO timestamp of the observation, so a caller can judge its age. */
  observedAt?: string;
}

export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network: string;
  payer?: string;
  errorReason?: string;
  /**
   * Added additively. Facilitators that do not populate it keep working, and
   * callers that do not read it behave exactly as before — but a caller that
   * sets `requireSettlement` on `gate()` can now refuse to release against a
   * transaction the facilitator has not claimed is strong enough.
   */
  settlement?: SettlementEvidence;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: Network;
}
