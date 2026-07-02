# @furlpay/x402

[![npm](https://img.shields.io/badge/npm-%40furlpay%2Fx402-cb3837)](https://www.npmjs.com/package/@furlpay/x402)
[![CI](https://github.com/FurlPay/furlpay-x402/actions/workflows/ci.yml/badge.svg)](https://github.com/FurlPay/furlpay-x402/actions)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**Gate any API behind an [x402](https://x402.org) micropayment** so AI agents pay
per request in USDC — with verification and on-chain settlement delegated to a
facilitator. Furlpay runs the **first Solana-native x402 facilitator** (also on
Base); point at your own deployment to self-host.

Zero runtime dependencies. Node 18+.

## Install

```bash
npm install @furlpay/x402
```

## Gate a Next.js route

```ts
import { withX402 } from "@furlpay/x402";

export const GET = withX402(
  async () => Response.json({ quote: { USDEUR: 0.917 } }),
  {
    payTo: "YourTreasuryAddress",
    network: "solana",       // or "base"
    amount: "10000",          // 0.01 USDC (6 decimals)
    description: "Mid-market FX quote",
  }
);
```

An unpaid request gets `402` with the payment requirements; the agent signs,
retries with an `X-PAYMENT` header, and the response carries an
`X-PAYMENT-RESPONSE` settlement receipt.

## Gate an Express route

```ts
import { expressX402 } from "@furlpay/x402";

app.get("/premium", expressX402({ payTo: "0x...", network: "base", amount: "10000" }), (req, res) => {
  res.json({ data: "premium" });
});
```

## Call the facilitator directly

```ts
import { useFacilitator } from "@furlpay/x402";

const facilitator = useFacilitator(); // Furlpay hosted (Solana + Base)
const { kinds } = await facilitator.supported();
const check = await facilitator.verify(paymentPayload, paymentRequirements);
const receipt = await facilitator.settle(paymentPayload, paymentRequirements);
```

## Facilitator API

The hosted facilitator lives at `https://furlpay.com/api/x402/facilitator`:

| Route | Purpose |
|---|---|
| `GET /supported` | `(scheme, network)` kinds this facilitator settles |
| `POST /verify` | Validate a payment payload against requirements |
| `POST /settle` | Verify + settle on-chain (single-use nonce → replay-safe) |

## Why a facilitator

An x402 facilitator is the middleware between agents and chains — it verifies
payment authorizations and handles settlement/gas, so your API never touches
wallet infrastructure. It's Stripe for AI-agent payments. Verification is
hardened against the authorization/binding/replay/web-layer attack classes from
2026 x402 research.

## License

MIT
