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

export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: Network;
}
