import crypto from "node:crypto";
import type { PaymentRequirements } from "./types";

// ---------------------------------------------------------------------------
// Resource binding — stopping a payment for A from unlocking B.
//
// THE HOLE. The `exact` scheme's authorization names a recipient and an amount
// and nothing else. Two routes on the same server at the same price therefore
// accept each other's payments: every field check passes, because every field
// genuinely matches. A buyer pays $0.01 for /cheap and replays that same
// authorization against /expensive-but-same-price, or simply against /cheap
// belonging to a different tenant. No amount of validating the fields that ARE
// present can close it, because the resource is not one of them.
//
// THE FIX. The server mints a quote when it issues the 402 and requires it back
// with the payment. The quote is HMAC'd with a server-held secret over the
// fields it is binding, so the payer can echo it but cannot mint one for a
// different resource, price or recipient.
//
// This is a server-to-itself commitment, which is what lets it work without any
// change to the x402 wire format: the quote rides in `PaymentRequirements.extra`
// on the way out and `PaymentPayload.extra` on the way back, both of which the
// spec already carries for exactly this kind of use.
// ---------------------------------------------------------------------------

/** What the quote commits to. Anything omitted here is NOT bound. */
interface QuoteClaims {
  /** The resource URL this quote was issued for. */
  r: string;
  /** Price in atomic units. */
  a: string;
  /** Recipient. */
  p: string;
  /** Network. */
  n: string;
  /** Expiry, epoch seconds. */
  e: number;
  /** Random, so two quotes for the same resource are distinguishable. */
  j: string;
}

export interface QuoteVerification {
  ok: boolean;
  reason?:
    | "quote_missing"
    | "quote_malformed"
    | "quote_signature_invalid"
    | "quote_expired"
    | "quote_resource_mismatch"
    | "quote_terms_mismatch";
  detail?: string;
  /** Present when valid — the unique id, for single-use claiming. */
  quoteId?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(body: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(body).digest());
}

/**
 * Mint a quote for this resource and these terms.
 *
 * `ttlSeconds` should track `maxTimeoutSeconds` — a quote that outlives the
 * authorization it accompanies is a binding that stops binding before the
 * payment stops being spendable.
 */
export function issueQuote(
  requirements: PaymentRequirements,
  secret: string,
  ttlSeconds: number
): string {
  const claims: QuoteClaims = {
    r: requirements.resource,
    a: requirements.maxAmountRequired,
    p: requirements.payTo,
    n: String(requirements.network),
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
    j: crypto.randomBytes(9).toString("hex"),
  };
  const body = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a presented quote against the requirements for the CURRENT request.
 *
 * The signature is checked before anything is read out of the body — a forged
 * quote's claims are attacker-controlled, and comparing them first would be
 * making decisions on data that has not been authenticated yet.
 */
export function verifyQuote(
  presented: unknown,
  requirements: PaymentRequirements,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): QuoteVerification {
  if (typeof presented !== "string" || !presented) {
    return { ok: false, reason: "quote_missing", detail: "no quote presented with the payment" };
  }
  const dot = presented.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "quote_malformed", detail: "quote is not body.sig" };

  const body = presented.slice(0, dot);
  const presentedSig = presented.slice(dot + 1);
  const expectedSig = sign(body, secret);

  // Constant-time, and length-guarded because timingSafeEqual throws on a
  // length mismatch — which would itself be a timing signal.
  const a = Buffer.from(presentedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "quote_signature_invalid", detail: "quote signature does not verify" };
  }

  let claims: QuoteClaims;
  try {
    claims = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "quote_malformed", detail: "quote body is not JSON" };
  }

  if (typeof claims.e !== "number" || nowSeconds >= claims.e) {
    return { ok: false, reason: "quote_expired", detail: "quote has expired" };
  }

  // THE CHECK THIS FILE EXISTS FOR.
  if (claims.r !== requirements.resource) {
    return {
      ok: false,
      reason: "quote_resource_mismatch",
      detail: "quote was issued for a different resource",
    };
  }

  // The terms are bound too, so a quote cannot be replayed against the same
  // URL after its price or recipient changed.
  if (
    claims.a !== requirements.maxAmountRequired ||
    claims.p !== requirements.payTo ||
    claims.n !== String(requirements.network)
  ) {
    return {
      ok: false,
      reason: "quote_terms_mismatch",
      detail: "quote terms do not match the current requirements",
    };
  }

  return { ok: true, quoteId: claims.j };
}
