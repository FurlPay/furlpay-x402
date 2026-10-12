// ---------------------------------------------------------------------------
// Single-use payment claims — middleware-level replay resistance.
//
// Without this, replay resistance is entirely the facilitator's. The paper
// observed 248 grants from one payment against a facilitator that did not
// linearize, and `gate()` had no opinion of its own: the same X-PAYMENT header
// replayed N times released the resource N times.
//
// THE RELEASE RULE IS THE WHOLE DESIGN. A claim is taken BEFORE settlement, so
// two concurrent copies of one payment cannot both reach the settler. What
// happens afterwards is where this gets decided correctly or dangerously:
//
//   settle returns success       -> keep the claim (spent)
//   settle returns a definite no -> RELEASE it; no money moved, and a payer
//                                   retrying after a declined card must not be
//                                   locked out of their own authorization
//   settle throws / times out    -> KEEP it. The outcome is UNKNOWN, and
//                                   "unknown" is not "did not happen".
//
// That last branch is the one that is tempting to get wrong. Releasing on a
// timeout feels tidy and re-opens the replay window for exactly the payment
// most likely to have actually landed.
// ---------------------------------------------------------------------------

export interface PaymentClaimStore {
  /**
   * Claim `key` if unclaimed. Returns true iff THIS caller won it.
   *
   * Must be atomic against concurrent callers. The in-memory implementation is
   * atomic only within one process, which is why it is documented as
   * single-instance.
   *
   * `holdUntilMs` is the earliest instant (epoch ms) the claim may lapse: the
   * authorization's own expiry plus a margin. A store with a fixed TTL must
   * keep the claim at least this long. A claim that lapses while the
   * authorization is still valid reopens replay for that authorization, which
   * is the one thing this store exists to prevent.
   */
  claim(key: string, holdUntilMs?: number): boolean | Promise<boolean>;
  /** Give a claim back. Called only when settlement definitively did not occur. */
  release(key: string): void | Promise<void>;
}

/**
 * In-memory claim store.
 *
 * SINGLE INSTANCE ONLY, and this is not a detail. Its atomicity comes from Node
 * being single-threaded, which is a real guarantee inside one process and worth
 * nothing across two workers, two containers, or two regions. Behind a load
 * balancer each instance holds its own set and the same payment can be replayed
 * once per instance. Inject a shared store (Redis `SET NX`) for anything
 * running more than one copy.
 */
export class MemoryClaimStore implements PaymentClaimStore {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  /** `ttlSeconds` should exceed the longest authorization validity window. */
  constructor(ttlSeconds = 3600) {
    this.ttlMs = ttlSeconds * 1000;
  }

  private sweep(now: number): void {
    // Bounded work per call rather than a timer: a timer would keep a process
    // alive, and this map only grows when payments arrive.
    if (this.seen.size < 512) return;
    for (const [k, expires] of this.seen) {
      if (expires <= now) this.seen.delete(k);
    }
  }

  claim(key: string, holdUntilMs?: number): boolean {
    const now = Date.now();
    this.sweep(now);
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) return false;
    // The longer of the configured TTL and the authorization's own lifetime.
    this.seen.set(key, Math.max(now + this.ttlMs, holdUntilMs ?? 0));
    return true;
  }

  release(key: string): void {
    this.seen.delete(key);
  }

  /** Live claim count. Diagnostics only. */
  get size(): number {
    return this.seen.size;
  }
}

/**
 * The key a payment is claimed under: its network and its on-chain nonce.
 *
 * THE NONCE IS THE REPLAY IDENTITY IN EVERY MODE. It is the one value bound to
 * the money: the token contract consumes it, and a payer who picks another one
 * has signed another payment. The quote is not an identity. Earlier versions
 * keyed on the quote id when resource binding was on, and a quote is free and
 * unlimited (one per 402 challenge), so one authorization presented under N
 * quotes won N claims and released the resource N times. Binding verifies the
 * quote as an extra restriction; it never replaces the nonce.
 *
 * Network-scoped because a nonce is only unique within its own chain. Pass a
 * nonce from `canonicalNonce`: two spellings of one on-chain nonce must not
 * become two keys.
 *
 * @param _quoteId Ignored, kept so existing callers still compile. The quote is
 *                 never part of the replay identity.
 */
export function claimKey(network: string, nonce: string, _quoteId?: string): string {
  return `n:${network}:${nonce}`;
}

export type NonceCheck = { ok: true; nonce: string } | { ok: false; detail: string };

const BYTES32_HEX = /^(0[xX])?[0-9a-fA-F]{64}$/;
/** Base58/base64url-style identifiers for non-EVM networks: no separators, bounded. */
const OPAQUE_NONCE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Validate a payer-supplied nonce and reduce it to one spelling per on-chain value.
 *
 * Without this, single use is defeated without touching the quote at all. An
 * EIP-3009 nonce is a bytes32, and the signature covers its VALUE, so `0xAB…`,
 * `0xab…` and `ab…` are one authorization to the token contract but three
 * claim keys to a string comparison. A short hex value is refused rather than
 * padded: a facilitator that left-pads `0x1` makes it the same nonce as `0x01`.
 *
 * EVM networks (any network not named solana*) require exactly 32 bytes of hex,
 * canonicalized to lowercase with a `0x` prefix. Solana identifiers are base58,
 * where case is significant, so they are length- and charset-checked and kept
 * as given. An empty, missing or malformed nonce is refused, never claimed:
 * keyed as "", every such payment would share one claim.
 */
export function canonicalNonce(network: string, nonce: unknown): NonceCheck {
  if (typeof nonce !== "string" || nonce.length === 0) {
    return { ok: false, detail: "authorization.nonce is missing" };
  }
  const hexForm = !network.startsWith("solana") || /^0x/i.test(nonce);
  if (hexForm) {
    return BYTES32_HEX.test(nonce)
      ? { ok: true, nonce: "0x" + nonce.replace(/^0x/i, "").toLowerCase() }
      : { ok: false, detail: "authorization.nonce must be 32 bytes of hex" };
  }
  return OPAQUE_NONCE.test(nonce)
    ? { ok: true, nonce }
    : { ok: false, detail: "authorization.nonce is malformed" };
}
