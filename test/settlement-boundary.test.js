"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { gate, useFacilitator } = require("../dist/index.js");

// ---------------------------------------------------------------------------
// The transport answer and the application answer must not blend.
//
// The bug: post() was `return (await res.json())` with the HTTP status never
// read, so a 500 whose body happened to be {"success":true} was accepted as a
// settlement and the resource shipped. These tests assert the boundary rather
// than the single example — a status failure must beat an optimistic body
// whatever the status and whatever the body.
// ---------------------------------------------------------------------------

const CFG = { payTo: "0x1111111111111111111111111111111111111111", amount: "10000" };

// A payment that satisfies `gate()`'s local checks, so this file keeps testing
// the SETTLEMENT-STRENGTH boundary rather than stopping at field validation.
// It was `payload: {}` before those checks existed; with them, the sweep below
// would never reach a release and its own anti-vacuity guard catches that.
const NOW = Math.floor(Date.now() / 1000);
const HEADER = Buffer.from(
  JSON.stringify({
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature: "0xsignature",
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: CFG.payTo,
        value: CFG.amount,
        validAfter: String(NOW - 60),
        validBefore: String(NOW + 600),
        nonce: "0xnonce",
      },
    },
  })
).toString("base64");

/** A fetch that answers every call with one status and one body. */
function stubFetch(status, body, contentType) {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": contentType || "application/json" },
    });
}

function facilitatorReturning(status, body, contentType) {
  return useFacilitator("https://facilitator.test", stubFetch(status, body, contentType));
}

async function settleVia(status, body, contentType) {
  return gate("https://api.test/premium", HEADER, {
    ...CFG,
    facilitator: facilitatorReturning(status, body, contentType),
  });
}

const OK_BODY = { success: true, transaction: "0xdeadbeef", network: "base", payer: "0xpayer" };

// -- A-F: the required regression matrix -----------------------------------

test("A: 200 + success:true settles", async () => {
  const r = await settleVia(200, OK_BODY);
  assert.strictEqual(r.paid, true);
  assert.strictEqual(r.transaction, "0xdeadbeef");
});

test("B: 500 + success:true does NOT settle", async () => {
  const r = await settleVia(500, { success: true, transaction: "0xdeadbeef", network: "base" });
  assert.strictEqual(r.paid, false);
  assert.strictEqual(r.status, 402);
  assert.match(r.body.error, /facilitator_http_500/);
});

test("C: 400 + success:true does NOT settle", async () => {
  const r = await settleVia(400, { success: true, transaction: "0xdeadbeef", network: "base" });
  assert.strictEqual(r.paid, false);
  assert.match(r.body.error, /facilitator_http_400/);
});

test("D: 200 + success:false does NOT settle", async () => {
  const r = await settleVia(200, { success: false, network: "base", errorReason: "insufficient" });
  assert.strictEqual(r.paid, false);
  assert.strictEqual(r.body.error, "insufficient");
});

test("E: 200 + malformed JSON does NOT settle", async () => {
  const r = await settleVia(200, "<html>gateway error</html>", "text/html");
  assert.strictEqual(r.paid, false);
  assert.strictEqual(r.body.error, "facilitator_response_not_json");
});

test("F: 200 + success:true but no transaction does NOT settle", async () => {
  const r = await settleVia(200, { success: true, network: "base" });
  assert.strictEqual(r.paid, false);
  assert.strictEqual(r.body.error, "settlement_missing_transaction");
});

// -- The boundary, swept ---------------------------------------------------

test("no non-2xx status can be overridden by an optimistic body", async () => {
  for (const status of [400, 401, 402, 403, 404, 409, 418, 429, 500, 502, 503, 504]) {
    const r = await settleVia(status, OK_BODY);
    assert.strictEqual(r.paid, false, "status " + status + " released the resource");
  }
});

test("non-object JSON bodies are refused", async () => {
  for (const body of ["[]", "123", "null", "true"]) {
    const r = await settleVia(200, body);
    assert.strictEqual(r.paid, false, "body " + body + " released the resource");
  }
});

test("an empty body is refused rather than cast", async () => {
  const r = await settleVia(200, "");
  assert.strictEqual(r.paid, false);
});

test("success must be the boolean true, not merely truthy", async () => {
  for (const success of ["true", 1, {}, [], "yes"]) {
    const r = await settleVia(200, { success, transaction: "0xabc", network: "base" });
    assert.strictEqual(r.paid, false, "truthy success released the resource");
  }
});

test("a network failure is a failed settlement, not a thrown rejection", async () => {
  const facilitator = useFacilitator("https://facilitator.test", async () => {
    throw new TypeError("fetch failed");
  });
  const r = await gate("https://api.test/premium", HEADER, { ...CFG, facilitator });
  assert.strictEqual(r.paid, false);
  assert.match(r.body.error, /facilitator_unreachable/);
});

test("the error reason carries no message text from the thrown error", async () => {
  const facilitator = useFacilitator("https://facilitator.test", async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.1:443 secret-internal-host");
  });
  const r = await gate("https://api.test/premium", HEADER, { ...CFG, facilitator });
  assert.strictEqual(/ECONNREFUSED|secret-internal-host/.test(r.body.error), false);
});

// -- Settlement strength gating --------------------------------------------

test("without requireSettlement the gate behaves as before", async () => {
  const r = await settleVia(200, OK_BODY);
  assert.strictEqual(r.paid, true);
});

test("requireSettlement holds when the facilitator claims nothing", async () => {
  const r = await gate("https://api.test/premium", HEADER, {
    ...CFG,
    requireSettlement: "confirmed",
    facilitator: facilitatorReturning(200, OK_BODY),
  });
  assert.strictEqual(r.paid, false);
  assert.match(r.body.error, /settlement_strength_insufficient/);
  assert.match(r.body.error, /observed unknown/);
});

test("confirmed does not satisfy a finalized requirement", async () => {
  const r = await gate("https://api.test/premium", HEADER, {
    ...CFG,
    requireSettlement: "finalized",
    facilitator: facilitatorReturning(200, {
      ...OK_BODY,
      settlement: { strength: "confirmed", confirmations: 40 },
    }),
  });
  assert.strictEqual(r.paid, false);
  assert.match(r.body.error, /required finalized, observed confirmed/);
});

test("finalized satisfies a confirmed requirement", async () => {
  const r = await gate("https://api.test/premium", HEADER, {
    ...CFG,
    requireSettlement: "confirmed",
    facilitator: facilitatorReturning(200, {
      ...OK_BODY,
      settlement: { strength: "finalized", confirmations: null },
    }),
  });
  assert.strictEqual(r.paid, true);
  assert.strictEqual(r.settlement.strength, "finalized");
});

test("an unrecognised strength is read as unknown, never inferred from success", async () => {
  const r = await gate("https://api.test/premium", HEADER, {
    ...CFG,
    requireSettlement: "confirmed",
    facilitator: facilitatorReturning(200, {
      ...OK_BODY,
      settlement: { strength: "totally_settled_trust_me" },
    }),
  });
  assert.strictEqual(r.paid, false);
  assert.match(r.body.error, /observed unknown/);
});

test("INVARIANT: no status/body combination releases below the required strength", async () => {
  const statuses = [200, 201, 400, 500];
  const strengths = [undefined, "unknown", "submitted", "confirmed", "finalized", "bogus"];
  const rank = { unknown: 0, submitted: 1, confirmed: 2, finalized: 3 };
  let released = 0;

  for (const status of statuses) {
    for (const strength of strengths) {
      const body = { ...OK_BODY };
      if (strength !== undefined) body.settlement = { strength };
      const r = await gate("https://api.test/premium", HEADER, {
        ...CFG,
        requireSettlement: "confirmed",
        facilitator: facilitatorReturning(status, body),
      });
      if (r.paid !== true) continue;
      released++;
      assert.ok(status >= 200 && status < 300, "released on HTTP " + status);
      const observed = (r.settlement && r.settlement.strength) || "unknown";
      assert.ok(rank[observed] >= rank.confirmed, "released at strength " + observed);
    }
  }
  assert.ok(released > 0, "the sweep never released - the test would be vacuous");
});
