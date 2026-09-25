import { DEFAULT_FACILITATOR, useFacilitator, type Facilitator } from "./facilitator";
import { verifyLocally } from "./verify";
import { issueQuote, verifyQuote } from "./binding";
import { MemoryClaimStore, claimKey, type PaymentClaimStore } from "./claims";
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
  /**
   * Skip the local field checks and let the facilitator decide alone.
   *
   * Exists as an escape hatch for a scheme whose payload this package cannot
   * interpret, not as a tuning knob — leaving it unset is the safe posture, and
   * setting it restores the behaviour where any facilitator weakness is a full
   * bypass. Named for what it does rather than something reassuring, so it is
   * hard to enable without noticing.
   */
  skipLocalVerification?: boolean;
  /**
   * Server-held secret that binds a payment to THIS resource.
   *
   * Set it and the 402 carries a signed quote the payer must echo back; the
   * gate then refuses any payment whose quote was issued for a different
   * resource, price or recipient. Without it there is no binding at all and two
   * routes at the same price on the same server accept each other's payments —
   * the `exact` scheme's authorization simply does not name a resource.
   *
   * Left unset the gate behaves as before, because turning binding on is a
   * protocol change for payers: they have to echo `extra.quote`. It is opt-in
   * for that reason, not because it is optional in any security sense.
   */
  bindingSecret?: string;
  /**
   * Single-use claim store, so one payment releases one resource.
   *
   * Defaults to a per-config in-memory store, which is correct in ONE process
   * and useless across a fleet — behind a load balancer each instance keeps its
   * own set and a payment replays once per instance. Inject a shared store for
   * anything running more than one copy.
   */
  claimStore?: PaymentClaimStore;
  /** Set false to disable claiming entirely. Replay then rests on the facilitator. */
  singleUse?: boolean;
}

/**
 * Default claim stores, one per distinct config object.
 *
 * Keyed by the config so two routes cannot collide in one another's claim
 * space, and weak so a config that goes out of scope does not pin its store.
 */
const DEFAULT_CLAIM_STORES = new WeakMap<PriceConfig, PaymentClaimStore>();

function resolveClaimStore(cfg: PriceConfig): PaymentClaimStore {
  if (cfg.claimStore) return cfg.claimStore;
  let store = DEFAULT_CLAIM_STORES.get(cfg);
  if (!store) {
    store = new MemoryClaimStore();
    DEFAULT_CLAIM_STORES.set(cfg, store);
  }
  return store;
}

/**
 * Headers that keep a paid response out of a shared cache.
 *
 * A gated route behind a CDN or reverse proxy will otherwise have its PAID
 * response cached and replayed to later UNPAID clients — one payment, unlimited
 * grants, and nothing in the payment layer involved. `private` bars shared
 * caches; `no-store` bars writing it down at all; `Vary: X-PAYMENT` stops a
 * cache that ignores the first two from keying paid and unpaid requests to one
 * entry.
 *
 * Applied to the 402 as well as the 200. A cached challenge is a cached quote,
 * and every payer served it would be answering the same one.
 */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store, private",
  Vary: "X-PAYMENT",
});

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
    // The challenge carries a fresh quote when binding is on. Minted per
    // challenge rather than per route so two payers never share one, which is
    // what makes the single-use claim below meaningful.
    const challenge = cfg.bindingSecret
      ? {
          ...requirements,
          extra: {
            ...requirements.extra,
            quote: issueQuote(requirements, cfg.bindingSecret, requirements.maxTimeoutSeconds),
          },
        }
      : requirements;
    return {
      paid: false,
      status: 402,
      body: { x402Version: X402_VERSION, error: "X-PAYMENT required", accepts: [challenge] },
    };
  }

  let payload: PaymentPayload;
  try {
    payload = JSON.parse(Buffer.from(xPaymentHeader, "base64").toString("utf8"));
  } catch {
    return { paid: false, status: 400, body: { error: "X-PAYMENT is not valid base64 JSON" } };
  }

  // LOCAL CHECKS BEFORE THE FACILITATOR SEES IT.
  //
  // `cfg.facilitator` is a documented option, so "the hosted one" and "any third
  // party" are the same code path — and delegating the whole decision made that
  // party the entire security boundary. These checks cost nothing and hold even
  // when the facilitator is wrong, misconfigured or hostile.
  //
  // Running them first also means a payment that does not match what we asked
  // for is never submitted for settlement at all. Settling first and refusing
  // afterwards would move money on-chain for a resource we then decline to
  // release, which is a worse failure than a 402.
  if (!cfg.skipLocalVerification) {
    const local = verifyLocally(payload, requirements);
    if (!local.ok) {
      return {
        paid: false,
        status: 402,
        body: {
          x402Version: X402_VERSION,
          error: `${local.reason}: ${local.detail ?? ""}`.trim(),
          accepts: [requirements],
        },
      };
    }
  }

  // RESOURCE BINDING. Field checks cannot catch cross-resource substitution,
  // because every field of a payment for another resource at the same price
  // genuinely matches. The quote is the only thing that names the resource.
  let quoteId: string | undefined;
  if (cfg.bindingSecret) {
    const q = verifyQuote(payload.extra?.quote, requirements, cfg.bindingSecret);
    if (!q.ok) {
      return {
        paid: false,
        status: 402,
        body: {
          x402Version: X402_VERSION,
          error: `${q.reason}: ${q.detail ?? ""}`.trim(),
          accepts: [requirements],
        },
      };
    }
    quoteId = q.quoteId;
  }

  // SINGLE USE. Claimed before settlement so two concurrent copies of one
  // payment cannot both reach the settler.
  const singleUse = cfg.singleUse !== false;
  const store = singleUse ? resolveClaimStore(cfg) : null;
  const key = claimKey(
    String(requirements.network),
    payload.payload?.authorization?.nonce ?? "",
    quoteId
  );
  if (store) {
    const won = await store.claim(key);
    if (!won) {
      return {
        paid: false,
        status: 402,
        body: {
          x402Version: X402_VERSION,
          error: "payment_already_used: this authorization has already released the resource",
          accepts: [requirements],
        },
      };
    }
  }

  const facilitator = resolveFacilitator(cfg.facilitator);
  let settlement: Awaited<ReturnType<Facilitator["settle"]>>;
  try {
    settlement = await facilitator.settle(payload, requirements);
  } catch (err) {
    // UNKNOWN, NOT FAILED. The settler may well have landed the transaction and
    // failed on the way back, so the claim is NOT released — releasing here
    // re-opens replay for the payment most likely to have actually settled.
    return {
      paid: false,
      status: 402,
      body: {
        x402Version: X402_VERSION,
        error: `settlement_unknown: ${(err as Error).message}`,
        accepts: [requirements],
      },
    };
  }

  if (!settlement.success) {
    // A definite no: no money moved, so the payer keeps their authorization and
    // can retry after fixing whatever the facilitator objected to. Holding the
    // claim here would lock someone out of their own unspent payment.
    if (store) await store.release(key);
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
    // RELEASED, because this 402 is an invitation to retry the SAME payment
    // once it is deeper. Holding the claim would make "wait and try again" the
    // one thing the payer cannot do. Releasing is safe here precisely because
    // nothing was released to them: a concurrent duplicate re-claiming only
    // reaches this same check and is refused the same way.
    if (store) await store.release(key);
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
      return Response.json(result.body, { status: result.status, headers: NO_STORE_HEADERS });
    }
    const res = await handler(req);
    res.headers.set("X-PAYMENT-RESPONSE", result.settlementHeader);
    // Set, not appended: a handler that already chose a caching policy chose it
    // without knowing the response was paid for, and a cacheable paid response
    // is served to the next unpaid caller.
    for (const [k, v] of Object.entries(NO_STORE_HEADERS)) res.headers.set(k, v);
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
    // Stamped before the branch: the challenge must be uncacheable too, and
    // setting it in both arms separately is how one of them drifts.
    for (const [k, v] of Object.entries(NO_STORE_HEADERS)) res.setHeader(k, v);
    if (!result.paid) {
      res.status(result.status).json(result.body);
      return;
    }
    res.setHeader("X-PAYMENT-RESPONSE", result.settlementHeader);
    next();
  };
}
