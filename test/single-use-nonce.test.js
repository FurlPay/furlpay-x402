"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { gate, buildRequirements, issueQuote, MemoryClaimStore, canonicalNonce } = require("../dist/index.js");

// ---------------------------------------------------------------------------
// One on-chain authorization releases a resource at most once.
//
// Regression suite for the single-use bypass: with resource binding on, the
// claim was keyed on the quote id, and a fresh quote comes free with every
// 402, so one authorization presented under N quotes released the resource N
// times and reached the settler N times. Every facilitator here approves
// everything it is handed, so each refusal is the middleware's own. A stub
// facilitator proves what the SDK does; it proves nothing about on-chain
// settlement.
// ---------------------------------------------------------------------------

const PAY_TO = "0x1111111111111111111111111111111111111111";
const SECRET = "test-binding-secret-value";
const RESOURCE = "https://api.example/premium";
const BOUND = { payTo: PAY_TO, amount: "10000", bindingSecret: SECRET };
const UNBOUND = { payTo: PAY_TO, amount: "10000" };

const now = () => Math.floor(Date.now() / 1000);
const freshNonce = () => "0x" + crypto.randomBytes(32).toString("hex");

function settler(result = () => ({ success: true, transaction: "0xtx", network: "base", payer: "0xpayer" })) {
  const calls = [];
  return {
    calls,
    supported: async () => ({ kinds: [] }),
    verify: async () => ({ isValid: true }),
    settle: async (payload) => {
      calls.push(payload.payload.authorization.nonce);
      return result(calls.length);
    },
  };
}

function payment({ nonce = freshNonce(), quote, network = "base", auth = {} } = {}) {
  return {
    x402Version: 1,
    scheme: "exact",
    network,
    payload: {
      signature: "0xsig",
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: PAY_TO,
        value: "10000",
        validAfter: String(now() - 60),
        validBefore: String(now() + 600),
        nonce,
        ...auth,
      },
    },
    extra: quote ? { quote } : undefined,
  };
}

const header = (p) => Buffer.from(JSON.stringify(p)).toString("base64");

/** A fresh quote, exactly as a payer gets one: by asking for the 402. */
async function quote(cfg, resource = RESOURCE) {
  return (await gate(resource, null, cfg)).body.accepts[0].extra.quote;
}

async function present(cfg, p, resource = RESOURCE) {
  return gate(resource, header(p), cfg);
}

// ── the reported attack ────────────────────────────────────────────────────

test("one authorization under three fresh quotes releases once and settles once", async () => {
  const f = settler();
  const cfg = { ...BOUND, facilitator: f };
  const nonce = freshNonce();
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await present(cfg, payment({ nonce, quote: await quote(cfg) })));

  assert.deepStrictEqual(results.map((r) => r.paid), [true, false, false]);
  assert.match(results[1].body.error, /^payment_already_used/);
  assert.match(results[2].body.error, /^payment_already_used/);
  assert.strictEqual(f.calls.length, 1, "the replays never reached the settler");
});

for (const [mode, base] of [["binding on", BOUND], ["binding off", UNBOUND]]) {
  test(`${mode}: first use pays, an identical replay is refused before settlement`, async () => {
    const f = settler();
    const cfg = { ...base, facilitator: f };
    const p = payment({ quote: base.bindingSecret ? await quote(cfg) : undefined });
    assert.strictEqual((await present(cfg, p)).paid, true);
    const replay = await present(cfg, p);
    assert.strictEqual(replay.paid, false);
    assert.match(replay.body.error, /^payment_already_used/);
    assert.strictEqual(f.calls.length, 1);
  });
}

test("concurrent copies of one authorization under distinct quotes: one reaches the settler", async () => {
  let release;
  const gateOpen = new Promise((r) => (release = r));
  const f = settler();
  const slow = { ...f, settle: async (p, r) => { await gateOpen; return f.settle(p, r); } };
  const cfg = { ...BOUND, facilitator: slow };
  const nonce = freshNonce();
  const quotes = await Promise.all(Array.from({ length: 8 }, () => quote(cfg)));
  const inflight = quotes.map((q) => present(cfg, payment({ nonce, quote: q })));
  release();
  const results = await Promise.all(inflight);
  assert.strictEqual(results.filter((r) => r.paid).length, 1);
  assert.strictEqual(f.calls.length, 1);
});

test("distinct authorizations proceed independently", async () => {
  const f = settler();
  const cfg = { ...BOUND, facilitator: f };
  const a = await present(cfg, payment({ quote: await quote(cfg) }));
  const b = await present(cfg, payment({ quote: await quote(cfg) }));
  assert.strictEqual(a.paid && b.paid, true);
  assert.strictEqual(f.calls.length, 2);
});

test("the same nonce on two networks does not collide in a shared store", async () => {
  const store = new MemoryClaimStore();
  const nonce = freshNonce();
  const onBase = await present({ ...UNBOUND, network: "base", claimStore: store, facilitator: settler() }, payment({ nonce }));
  const onSepolia = await present(
    { ...UNBOUND, network: "base-sepolia", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", claimStore: store, facilitator: settler() },
    payment({ nonce, network: "base-sepolia" })
  );
  assert.strictEqual(onBase.paid, true);
  assert.strictEqual(onSepolia.paid, true);
});

// ── spellings of one nonce ─────────────────────────────────────────────────

test("re-spelling the nonce (case, missing 0x) does not mint a new claim", async () => {
  const f = settler();
  const cfg = { ...UNBOUND, facilitator: f };
  const hex = crypto.randomBytes(32).toString("hex");
  assert.strictEqual((await present(cfg, payment({ nonce: "0x" + hex }))).paid, true);
  for (const variant of ["0x" + hex.toUpperCase(), "0X" + hex, hex, hex.toUpperCase()]) {
    const r = await present(cfg, payment({ nonce: variant }));
    assert.strictEqual(r.paid, false, `variant ${variant.slice(0, 6)}… was accepted`);
    assert.match(r.body.error, /^payment_already_used/);
  }
  assert.strictEqual(f.calls.length, 1);
});

test("canonicalNonce: one spelling per on-chain value, refusals for the rest", () => {
  const hex = "ab".repeat(32);
  assert.deepStrictEqual(canonicalNonce("base", "0x" + hex.toUpperCase()), { ok: true, nonce: "0x" + hex });
  assert.deepStrictEqual(canonicalNonce("base", hex), { ok: true, nonce: "0x" + hex });
  for (const bad of [undefined, null, "", "0x", "0x1", "0x" + "ab".repeat(31), "0x" + "ab".repeat(33), "0xnonce", "0x" + "zz".repeat(32), 7]) {
    assert.strictEqual(canonicalNonce("base", bad).ok, false, `accepted ${String(bad)}`);
  }
  // Solana: base58 is case-sensitive, so it is kept as given, never lowercased.
  const b58 = "5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP";
  assert.deepStrictEqual(canonicalNonce("solana", b58), { ok: true, nonce: b58 });
  assert.notDeepStrictEqual(canonicalNonce("solana", b58.toLowerCase()), canonicalNonce("solana", b58));
  assert.strictEqual(canonicalNonce("solana", "a:b").ok, false);
  assert.strictEqual(canonicalNonce("solana", "short").ok, false);
  assert.deepStrictEqual(canonicalNonce("solana-devnet", b58), { ok: true, nonce: b58 });
});

test("a missing, empty or malformed nonce is refused before settlement", async () => {
  const f = settler();
  const cfg = { ...UNBOUND, facilitator: f };
  for (const nonce of [undefined, "", "0x", "0x1", "not-hex"]) {
    // Through `auth`: `payment({ nonce: undefined })` would take the default.
    const r = await present(cfg, payment({ auth: { nonce } }));
    assert.strictEqual(r.paid, false);
    assert.match(r.body.error, /^malformed_payload/);
  }
  assert.strictEqual(f.calls.length, 0);
});

test("the nonce is required even when local verification is skipped", async () => {
  const f = settler();
  const cfg = { ...UNBOUND, facilitator: f, skipLocalVerification: true };
  const r = await present(cfg, payment({ auth: { nonce: "" } }));
  assert.strictEqual(r.paid, false);
  assert.strictEqual(f.calls.length, 0);
});

test("an authorization with no usable validBefore cannot be claimed", async () => {
  const f = settler();
  const cfg = { ...UNBOUND, facilitator: f, skipLocalVerification: true };
  for (const validBefore of [undefined, "", "0", "soon", "1e30"]) {
    const r = await present(cfg, payment({ auth: { validBefore } }));
    assert.strictEqual(r.paid, false, `validBefore=${validBefore} was claimed`);
  }
  assert.strictEqual(f.calls.length, 0);
});

// ── the quote still restricts ──────────────────────────────────────────────

test("a bad quote grants nothing and never reaches the settler", async () => {
  const f = settler();
  const cfg = { ...BOUND, facilitator: f };
  const req = buildRequirements(RESOURCE, cfg);
  const good = await quote(cfg);
  const cases = {
    missing: undefined,
    tampered: good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA"),
    "other resource": await quote(cfg, "https://api.example/cheap"),
    expired: issueQuote(req, SECRET, -5),
    "other secret": issueQuote(req, "a-different-secret", 300),
    "other price": issueQuote({ ...req, maxAmountRequired: "1" }, SECRET, 300),
    "other recipient": issueQuote({ ...req, payTo: "0x3333333333333333333333333333333333333333" }, SECRET, 300),
    "other network": issueQuote({ ...req, network: "solana" }, SECRET, 300),
  };
  for (const [name, q] of Object.entries(cases)) {
    const r = await present(cfg, payment({ quote: q }));
    assert.strictEqual(r.paid, false, `${name} quote was accepted`);
    assert.match(r.body.error, /^quote_/, name);
  }
  assert.strictEqual(f.calls.length, 0);
});

test("wrong recipient, network or amount is refused before settlement", async () => {
  const f = settler();
  const cfg = { ...BOUND, facilitator: f };
  const wrong = [
    payment({ quote: await quote(cfg), auth: { to: "0x3333333333333333333333333333333333333333" } }),
    { ...payment({ quote: await quote(cfg) }), network: "solana" },
    payment({ quote: await quote(cfg), auth: { value: "9999" } }),
  ];
  for (const p of wrong) assert.strictEqual((await present(cfg, p)).paid, false);
  assert.strictEqual(f.calls.length, 0);
});

// ── settlement outcomes ────────────────────────────────────────────────────

test("a definite decline gives the claim back: one retry pays, then the nonce is spent", async () => {
  const f = settler((n) => (n === 1 ? { success: false, errorReason: "insufficient_funds" } : { success: true, transaction: "0xtx" }));
  const cfg = { ...BOUND, facilitator: f };
  const nonce = freshNonce();
  assert.strictEqual((await present(cfg, payment({ nonce, quote: await quote(cfg) }))).paid, false);
  assert.strictEqual((await present(cfg, payment({ nonce, quote: await quote(cfg) }))).paid, true);
  const third = await present(cfg, payment({ nonce, quote: await quote(cfg) }));
  assert.match(third.body.error, /^payment_already_used/);
  assert.strictEqual(f.calls.length, 2);
});

test("a settlement that throws keeps the claim, under any later quote", async () => {
  const f = settler(() => { throw new Error("socket hang up"); });
  const cfg = { ...BOUND, facilitator: f };
  const nonce = freshNonce();
  const first = await present(cfg, payment({ nonce, quote: await quote(cfg) }));
  assert.match(first.body.error, /^settlement_unknown/);
  const retry = await present(cfg, payment({ nonce, quote: await quote(cfg) }));
  assert.match(retry.body.error, /^payment_already_used/);
  assert.strictEqual(f.calls.length, 1, "an unknown outcome is never settled a second time");
});

test("an insufficiently strong settlement can be retried but grants at most once", async () => {
  const f = settler((n) => ({
    success: true,
    transaction: "0xtx",
    settlement: { strength: n === 1 ? "submitted" : "finalized" },
  }));
  const cfg = { ...BOUND, facilitator: f, requireSettlement: "finalized" };
  const nonce = freshNonce();
  const grants = [];
  for (let i = 0; i < 4; i++) grants.push((await present(cfg, payment({ nonce, quote: await quote(cfg) }))).paid);
  assert.deepStrictEqual(grants, [false, true, false, false]);
});

// ── stores ─────────────────────────────────────────────────────────────────

test("a claim outlives a short store TTL for as long as the authorization is valid", async () => {
  // TTL 0 used to mean "immediately reclaimable", which reopened replay for
  // any authorization still inside its validBefore.
  const f = settler();
  const cfg = { ...UNBOUND, facilitator: f, claimStore: new MemoryClaimStore(0) };
  const p = payment({ auth: { validBefore: String(now() + 3600) } });
  assert.strictEqual((await present(cfg, p)).paid, true);
  assert.match((await present(cfg, p)).body.error, /^payment_already_used/);
  assert.strictEqual(f.calls.length, 1);
});

test("MemoryClaimStore holds a claim until holdUntilMs even past its TTL", () => {
  const s = new MemoryClaimStore(0);
  assert.strictEqual(s.claim("k", Date.now() + 60_000), true);
  assert.strictEqual(s.claim("k"), false);
  assert.strictEqual(s.claim("j", Date.now() - 1), true);
  assert.strictEqual(s.claim("j"), true, "an expired hold with zero TTL is reclaimable");
});

/** A shared store with SET-NX semantics and network latency, like Redis. */
function sharedStore() {
  const keys = new Map();
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 5));
  return {
    keys,
    claim: async (key, holdUntilMs) => {
      await tick();
      if (keys.has(key)) return false;
      keys.set(key, holdUntilMs);
      await tick();
      return true;
    },
    release: async (key) => {
      await tick();
      keys.delete(key);
    },
  };
}

test("two instances sharing one store: one authorization settles once across the fleet", async () => {
  const store = sharedStore();
  const f = settler();
  const instanceA = { ...BOUND, facilitator: f, claimStore: store };
  const instanceB = { ...BOUND, facilitator: f, claimStore: store };
  const nonce = freshNonce();
  const attempts = [];
  for (let i = 0; i < 6; i++) {
    const cfg = i % 2 ? instanceA : instanceB;
    attempts.push(present(cfg, payment({ nonce, quote: await quote(cfg) })));
  }
  const results = await Promise.all(attempts);
  assert.strictEqual(results.filter((r) => r.paid).length, 1);
  assert.strictEqual(f.calls.length, 1);
  const [held] = [...store.keys.values()];
  assert.ok(held >= (now() + 600) * 1000, "the store was told to hold the claim past validBefore");
});

// ── failure of the store itself ────────────────────────────────────────────

test("a claim store that throws fails closed: nothing settles, nothing is granted", async () => {
  const f = settler();
  const broken = { claim: async () => { throw new Error("redis down"); }, release: async () => {} };
  const cfg = { ...BOUND, facilitator: f, claimStore: broken };
  await assert.rejects(present(cfg, payment({ quote: await quote(cfg) })), /redis down/);
  assert.strictEqual(f.calls.length, 0);
});

test("a release that throws after a decline still grants nothing", async () => {
  const f = settler(() => ({ success: false, errorReason: "declined" }));
  const store = new MemoryClaimStore();
  const cfg = { ...UNBOUND, facilitator: f, claimStore: { claim: (k, h) => store.claim(k, h), release: async () => { throw new Error("redis down"); } } };
  await assert.rejects(present(cfg, payment()), /redis down/);
  assert.strictEqual(f.calls.length, 1);
});

// ── property: grants never exceed distinct authorizations ──────────────────

/** Deterministic PRNG so a failing seed can be replayed. */
function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("property: under random concurrent replays, spellings and quotes, each nonce settles at most once", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rand = prng(seed);
    const f = settler((n) => (rand() < 0.2 ? { success: false, errorReason: "declined" } : { success: true, transaction: "0xtx" + n }));
    const cfg = { ...(rand() < 0.5 ? BOUND : UNBOUND), facilitator: f, claimStore: sharedStore() };
    const hexes = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => crypto.randomBytes(32).toString("hex"));
    const spell = (h) => [`0x${h}`, `0x${h.toUpperCase()}`, h, `0X${h}`][Math.floor(rand() * 4)];
    const attempts = [];
    for (let i = 0; i < 12; i++) {
      const h = hexes[Math.floor(rand() * hexes.length)];
      const q = cfg.bindingSecret ? await quote(cfg) : undefined;
      attempts.push(present(cfg, payment({ nonce: spell(h), quote: q })).then((r) => ({ h, r })));
    }
    const results = await Promise.all(attempts);
    for (const h of hexes) {
      const grants = results.filter((x) => x.h === h && x.r.paid).length;
      assert.ok(grants <= 1, `seed ${seed}: nonce granted ${grants} times`);
    }
    assert.ok(results.filter((x) => x.r.paid).length <= hexes.length, `seed ${seed}`);
  }
});
