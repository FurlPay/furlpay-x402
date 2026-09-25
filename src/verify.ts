import type { PaymentPayload, PaymentRequirements } from "./types";

// ---------------------------------------------------------------------------
// Local verification of a payment against the requirements WE built.
//
// `gate()` used to hand the payload straight to `facilitator.settle()` and
// release the resource on `success`. That makes the facilitator the entire
// security boundary — and `cfg.facilitator` is a documented, first-class option,
// so "point it at your own" and "point it at a third party's" are the same
// code path. Any weakness there became a full bypass, with no second line.
//
// Everything below is checkable without a key, a network call, or the
// facilitator's cooperation: the payload either claims what we asked for or it
// does not. Running it BEFORE settle also means a mismatched payment is never
// submitted at all, rather than settled on-chain for a resource we then refuse
// to release.
//
// WHAT THIS IS NOT. These are field checks, not a signature check and not a
// resource binding. The `exact` scheme's authorization carries no resource, so
// a payment minted for resource A still satisfies every field of resource B on
// the same server at the same price. Closing THAT needs a binding the payer
// signs over — F1 in @furlpay/x402-guard — and it is called out in the result
// rather than quietly implied by a passing check.
// ---------------------------------------------------------------------------

export type VerificationFailure =
  | "scheme_mismatch"
  | "network_mismatch"
  | "version_mismatch"
  | "malformed_payload"
  | "recipient_mismatch"
  | "amount_below_required"
  | "amount_unparseable"
  | "authorization_expired"
  | "authorization_not_yet_valid";

export interface LocalVerification {
  ok: boolean;
  reason?: VerificationFailure;
  /** Human-readable, safe to return in a 402 body. */
  detail?: string;
}

/**
 * Address comparison that respects the chain's own rules.
 *
 * EVM addresses are hex and case-insensitive — EIP-55 checksumming means the
 * same address legitimately arrives in different cases, so a byte comparison
 * would reject a correct payment. Solana addresses are base58, where case is
 * significant and lowercasing would make two DIFFERENT addresses compare equal.
 * Blanket-lowercasing is wrong in one direction or the other on every chain, so
 * the shape decides.
 */
export function addressesEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const isHex = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
  if (isHex(a) && isHex(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Seconds since epoch, as x402 authorizations express validity. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface VerifyLocalOptions {
  /** Injected for tests; defaults to wall clock. */
  nowSeconds?: () => number;
  /**
   * Tolerance for clock skew between payer and resource server, in seconds.
   * Applied only to `validAfter`: accepting a not-yet-valid authorization for a
   * few seconds is a usability call, whereas extending an EXPIRED one would
   * widen exactly the window the expiry exists to close.
   */
  clockSkewSeconds?: number;
}

/**
 * Check a presented payload against the requirements this server built.
 *
 * Deliberately returns a reason rather than throwing: the caller turns it into
 * a 402 the payer can act on, and a thrown error would be indistinguishable
 * from the facilitator being down.
 */
export function verifyLocally(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  opts: VerifyLocalOptions = {}
): LocalVerification {
  const now = (opts.nowSeconds ?? nowSeconds)();
  const skew = opts.clockSkewSeconds ?? 5;

  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "malformed_payload", detail: "payload is not an object" };
  }

  // x402Version is checked first: a payload from another version of the
  // protocol may use the same field names for different things, so every check
  // below it would be reading fields whose meaning is not settled.
  if (payload.x402Version !== 1) {
    return {
      ok: false,
      reason: "version_mismatch",
      detail: `unsupported x402Version ${String(payload.x402Version)}`,
    };
  }
  if (payload.scheme !== requirements.scheme) {
    return {
      ok: false,
      reason: "scheme_mismatch",
      detail: `expected scheme ${requirements.scheme}, got ${String(payload.scheme)}`,
    };
  }
  if (payload.network !== requirements.network) {
    return {
      ok: false,
      reason: "network_mismatch",
      detail: `expected network ${requirements.network}, got ${String(payload.network)}`,
    };
  }

  const auth = payload.payload?.authorization;
  if (!auth || typeof auth !== "object") {
    return { ok: false, reason: "malformed_payload", detail: "missing payload.authorization" };
  }
  if (typeof payload.payload?.signature !== "string" || !payload.payload.signature) {
    // Not a signature CHECK — that needs a key and the chain's curve. This only
    // refuses a payload with no signature at all, which no facilitator could
    // settle and which should never reach one.
    return { ok: false, reason: "malformed_payload", detail: "missing payload.signature" };
  }

  // The check that matters most: is this payment addressed to US? A facilitator
  // that skips it would let a payment to any recipient unlock the resource.
  if (!addressesEqual(auth.to, requirements.payTo)) {
    return {
      ok: false,
      reason: "recipient_mismatch",
      detail: "authorization is not addressed to this resource's payTo",
    };
  }

  let value: bigint;
  let required: bigint;
  try {
    value = BigInt(auth.value);
    required = BigInt(requirements.maxAmountRequired);
  } catch {
    return { ok: false, reason: "amount_unparseable", detail: "amount is not an integer string" };
  }
  // `>=`, not `===`: overpaying is the payer's business and is not a reason to
  // refuse a resource they have more than covered.
  if (value < required) {
    return {
      ok: false,
      reason: "amount_below_required",
      detail: `authorized ${value.toString()} < required ${required.toString()}`,
    };
  }

  // Expiry is checked locally as well as at the facilitator. An expired
  // authorization that a facilitator accepts anyway is a replay window, and the
  // window is exactly as long as the facilitator's leniency.
  const validBefore = Number(auth.validBefore);
  const validAfter = Number(auth.validAfter);
  if (Number.isFinite(validBefore) && validBefore > 0 && now >= validBefore) {
    return {
      ok: false,
      reason: "authorization_expired",
      detail: `authorization expired at ${validBefore}`,
    };
  }
  if (Number.isFinite(validAfter) && validAfter > 0 && now + skew < validAfter) {
    return {
      ok: false,
      reason: "authorization_not_yet_valid",
      detail: `authorization valid from ${validAfter}`,
    };
  }

  return { ok: true };
}
