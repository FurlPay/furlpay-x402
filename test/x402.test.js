"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { buildRequirements, gate, withX402, useFacilitator, DEFAULT_FACILITATOR } = require("../dist/index.js");

const CFG = { payTo: "0x1111111111111111111111111111111111111111", amount: "10000" };

test("buildRequirements defaults to Base USDC with exact scheme", () => {
  const r = buildRequirements("https://api.example.com/premium", CFG);
  assert.strictEqual(r.scheme, "exact");
  assert.strictEqual(r.network, "base");
  assert.strictEqual(r.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.strictEqual(r.maxAmountRequired, "10000");
  assert.strictEqual(r.maxTimeoutSeconds, 300);
  assert.strictEqual(r.resource, "https://api.example.com/premium");
});

test("buildRequirements resolves Solana USDC for network=solana", () => {
  const r = buildRequirements("https://x", { ...CFG, network: "solana" });
  assert.strictEqual(r.asset, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
});

test("buildRequirements honours an explicit asset override", () => {
  const r = buildRequirements("https://x", { ...CFG, asset: "0xCUSTOM" });
  assert.strictEqual(r.asset, "0xCUSTOM");
});

test("gate without X-PAYMENT returns a 402 challenge with accepts[]", async () => {
  const result = await gate("https://x/premium", null, CFG);
  assert.strictEqual(result.paid, false);
  assert.strictEqual(result.status, 402);
  assert.strictEqual(result.body.x402Version, 1);
  assert.strictEqual(result.body.accepts.length, 1);
  assert.strictEqual(result.body.accepts[0].payTo, CFG.payTo);
});

test("gate rejects a malformed X-PAYMENT header with 400", async () => {
  const result = await gate("https://x/premium", "not-base64-json!!!", CFG);
  assert.strictEqual(result.paid, false);
  assert.strictEqual(result.status, 400);
});

function stubFacilitator(settlement) {
  return {
    supported: async () => ({ kinds: [] }),
    verify: async () => ({ isValid: true }),
    settle: async () => settlement,
  };
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

test("gate settles a valid payment and round-trips the settlement header", async () => {
  const settlement = { success: true, payer: "0xPAYER", transaction: "0xTX", network: "base" };
  const header = encodePayload({ x402Version: 1, scheme: "exact", network: "base", payload: {} });
  const result = await gate("https://x/premium", header, { ...CFG, facilitator: stubFacilitator(settlement) });
  assert.strictEqual(result.paid, true);
  assert.strictEqual(result.payer, "0xPAYER");
  assert.strictEqual(result.transaction, "0xTX");
  const decoded = JSON.parse(Buffer.from(result.settlementHeader, "base64").toString("utf8"));
  assert.deepStrictEqual(decoded, settlement);
});

test("gate surfaces facilitator failure as a fresh 402 with the error reason", async () => {
  const header = encodePayload({ x402Version: 1 });
  const result = await gate("https://x/premium", header, {
    ...CFG,
    facilitator: stubFacilitator({ success: false, errorReason: "insufficient_funds" }),
  });
  assert.strictEqual(result.paid, false);
  assert.strictEqual(result.status, 402);
  assert.strictEqual(result.body.error, "insufficient_funds");
});

test("withX402 gates a Next.js handler and stamps X-PAYMENT-RESPONSE", async () => {
  const settlement = { success: true, payer: "0xPAYER", transaction: "0xTX" };
  const handler = withX402(async () => Response.json({ data: "premium" }), {
    ...CFG,
    facilitator: stubFacilitator(settlement),
  });

  const challenge = await handler(new Request("https://x/premium"));
  assert.strictEqual(challenge.status, 402);

  const paid = await handler(
    new Request("https://x/premium", { headers: { "x-payment": encodePayload({ x402Version: 1 }) } })
  );
  assert.strictEqual(paid.status, 200);
  assert.ok(paid.headers.get("X-PAYMENT-RESPONSE"));
});

test("useFacilitator posts verify/settle to the configured base URL", async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, body: init ? JSON.parse(init.body) : null });
    return { json: async () => ({ ok: true }) };
  };
  const f = useFacilitator("https://fac.example.com/x402/", fetchStub);
  await f.supported();
  await f.verify({ x402Version: 1 }, { scheme: "exact" });
  await f.settle({ x402Version: 1 }, { scheme: "exact" });
  assert.strictEqual(calls[0].url, "https://fac.example.com/x402/supported");
  assert.strictEqual(calls[1].url, "https://fac.example.com/x402/verify");
  assert.strictEqual(calls[1].body.x402Version, 1);
  assert.strictEqual(calls[2].url, "https://fac.example.com/x402/settle");
});

test("DEFAULT_FACILITATOR points at the hosted Furlpay facilitator", () => {
  assert.strictEqual(DEFAULT_FACILITATOR, "https://furlpay.com/api/x402/facilitator");
});
