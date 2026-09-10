import { DEFAULT_FACILITATOR, useFacilitator, type Facilitator } from "./facilitator";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettlementEvidence,
  SettlementStrength,
} from "./types";

// Framework-agnostic payment gate + Next.js / Express adapters. Gate a route
// behind an x402 micropayment in a few lines; verification and on-chain
// settlement are delegated to a facilitator (Furlpay hosted by default).

const X402_VERSION = 1;

export interface PriceConfig {
  payTo: string;
  network?: Network;
  asset?: string;
  /** Price in atomic units of `asset` (USDC = 6 decimals). e.g. "10000" = $0.01. */
  amount: string;
  description?: string;
  facilitator?: string | Facilitator;
  maxTimeoutSeconds?: number;
  /**
   * Minimum settlement strength before the resource is released.
   *
   * Left unset, `gate()` behaves as it always has: the facilitator says
   * `success: true` and the resource ships. That is the right default only
   * because changing it would break every existing caller — it is NOT a safe
   * posture, and it is why this option exists.
   *
   * Set it and the gate refuses to release against a settlement the facilitator
   * has not claimed is strong enough. `"confirmed"` stops a release against a
   * transaction that is merely broadcast; `"finalized"` stops a release against
   * one a re-org could still undo, which is what the amount at risk should
   * decide. @furlpay/settlement maps an amount to that requirement.
   */
  requireSettlement?: SettlementStrength;
}

const USDC = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
} as const;

export function buildRequirements(resource: string, cfg: PriceConfig): PaymentRequirements {
  const network = cfg.network ?? "base";
  return {
    scheme: "exact",
    network,
    maxAmountRequired: cfg.amount,
    resource,
    description: cfg.description ?? "x402 payment",
    mimeType: "application/json",
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? 300,
    asset: cfg.asset ?? USDC[network as "base" | "solana"] ?? USDC.base,
  };
}

function resolveFacilitator(f: PriceConfig["facilitator"]): Facilitator {
  if (!f) return useFacilitator(DEFAULT_FACILITATOR);
  return typeof f === "string" ? useFacilitator(f) : f;
}

/** Ascending strength. Compared, never assumed. */
const STRENGTH_RANK: Record<SettlementStrength, number> = {
  unknown: 0,
  submitted: 1,
  confirmed: 2,
  finalized: 3,
};

/**
 * Does the evidence clear the bar?
 *
 * Absent evidence is `unknown`, which clears only an `unknown` requirement.
 * Nothing here infers strength from `success` — that inference is precisely the
 * bug this gate exists to prevent.
 */
function meetsStrength(
  evidence: SettlementEvidence | undefined,
  required: SettlementStrength
): boolean {
  const observed: SettlementStrength = evidence?.strength ?? "unknown";
  return STRENGTH_RANK[observed] >= STRENGTH_RANK[required];
}

export type GateResult =
  | { paid: false; status: 402; body: { x402Version: number; error: string; accepts: PaymentRequirements[] } }
  | { paid: false; status: 400; body: { error: string } }
  | { paid: true; payer: string; transaction: string; settlementHeader: string; settlement?: SettlementEvidence };

/**
 * Core gate: given the resource URL and the incoming X-PAYMENT header, returns
 * either a 402 challenge or a paid result with the settlement receipt.
 */
export async function gate(resource: string, xPaymentHeader: string | null, cfg: PriceConfig): Promise<GateResult> {
  const requirements = buildRequirements(resource, cfg);

  if (!xPaymentHeader) {
    return {
      paid: false,
      status: 402,
      body: { x402Version: X402_VERSION, error: "X-PAYMENT required", accepts: [requirements] },
    };
  }

  let payload: PaymentPayload;
  try {
    payload = JSON.parse(Buffer.from(xPaymentHeader, "base64").toString("utf8"));
  } catch {
    return { paid: false, status: 400, body: { error: "X-PAYMENT is not valid base64 JSON" } };
  }

  const facilitator = resolveFacilitator(cfg.facilitator);
  const settlement = await facilitator.settle(payload, requirements);
  if (!settlement.success) {
    return {
      paid: false,
      status: 402,
      body: { x402Version: X402_VERSION, error: settlement.errorReason ?? "payment_failed", accepts: [requirements] },
    };
  }

  // The requirement is checked AFTER settlement succeeded and BEFORE anything is
  // released. A settlement that landed but is not yet strong enough is not an
  // error — it is a 402 the payer can clear by waiting, so the challenge is
  // returned rather than a failure.
  if (cfg.requireSettlement && !meetsStrength(settlement.settlement, cfg.requireSettlement)) {
    return {
      paid: false,
      status: 402,
      body: {
        x402Version: X402_VERSION,
        error: `settlement_strength_insufficient: required ${cfg.requireSettlement}, observed ${
          settlement.settlement?.strength ?? "unknown"
        }`,
        accepts: [requirements],
      },
    };
  }

  const settlementHeader = Buffer.from(JSON.stringify(settlement)).toString("base64");
  // `transaction` is guaranteed non-empty by the facilitator client, which
  // refuses a success that does not name one. The non-null assertions that used
  // to sit here were asserting over unvalidated remote data.
  return {
    paid: true,
    payer: settlement.payer ?? "",
    transaction: settlement.transaction ?? "",
    settlementHeader,
    settlement: settlement.settlement,
  };
}

/**
 * Next.js App Router wrapper. Gates a Route Handler behind an x402 payment.
 *
 * @example
 *   export const GET = withX402(
 *     async () => Response.json({ data: "premium" }),
 *     { payTo: "0x...", network: "base", amount: "10000", description: "Premium data" },
 *   );
 */
export function withX402(
  handler: (req: Request) => Promise<Response> | Response,
  cfg: PriceConfig
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const result = await gate(req.url, req.headers.get("x-payment"), cfg);
    if (!result.paid) {
      return Response.json(result.body, { status: result.status });
    }
    const res = await handler(req);
    res.headers.set("X-PAYMENT-RESPONSE", result.settlementHeader);
    return res;
  };
}

// Minimal Express-style types so we don't depend on @types/express.
interface ReqLike { originalUrl?: string; url: string; headers: Record<string, string | string[] | undefined>; }
interface ResLike { status(code: number): ResLike; json(body: unknown): void; setHeader(k: string, v: string): void; }

/**
 * Express/Connect middleware. Gates the mounted route behind an x402 payment.
 *
 * @example
 *   app.get("/premium", expressX402({ payTo: "0x...", amount: "10000" }), handler);
 */
export function expressX402(cfg: PriceConfig) {
  return async (req: ReqLike, res: ResLike, next: () => void) => {
    const header = req.headers["x-payment"];
    const xPayment = Array.isArray(header) ? header[0] : header ?? null;
    const result = await gate(req.originalUrl ?? req.url, xPayment, cfg);
    if (!result.paid) {
      res.status(result.status).json(result.body);
      return;
    }
    res.setHeader("X-PAYMENT-RESPONSE", result.settlementHeader);
    next();
  };
}
