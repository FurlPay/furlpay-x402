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
   */
  claim(key: string): boolean | Promise<boolean>;
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

  claim(key: string): boolean {
    const now = Date.now();
    this.sweep(now);
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(key, now + this.ttlMs);
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
 * The key a payment is claimed under.
 *
 * Network-scoped because a nonce is only unique within its own chain, and two
 * chains can legitimately produce the same nonce value. Quote-scoped when
 * binding is on, so the claim is per ISSUED QUOTE rather than per
 * payer-chosen nonce — a payer controls their own nonce, and a claim keyed
 * solely on something the payer picks is a claim they can sidestep by picking
 * another one.
 */
export function claimKey(network: string, nonce: string, quoteId?: string): string {
  return quoteId ? `q:${network}:${quoteId}` : `n:${network}:${nonce}`;
}
