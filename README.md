# @furlpay/x402

[![npm](https://img.shields.io/npm/v/%40furlpay%2Fx402)](https://www.npmjs.com/package/@furlpay/x402)
[![CI](https://github.com/FurlPay/furlpay-x402/actions/workflows/ci.yml/badge.svg)](https://github.com/FurlPay/furlpay-x402/actions)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

x402 payment middleware and facilitator client — gate any HTTP route behind a stablecoin micropayment in a few lines. Built on the [x402 protocol](https://www.x402.org/) (HTTP 402 "Payment Required" revived for machine-to-machine payments), with the first Solana-native facilitator alongside Base support.

- Framework adapters for Next.js App Router and Express/Connect, plus a framework-agnostic core.
- Verification and on-chain settlement are delegated to a facilitator — the hosted Furlpay facilitator by default, or point at your own.
- USDC on Base and Solana resolved automatically; any SPL/ERC-20 asset via config.
- Zero runtime dependencies. Node 18+. TypeScript types included.

## Why x402

AI agents, scripts, and API clients cannot fill out card checkout forms. x402 lets a server answer `402 Payment Required` with machine-readable payment requirements; the client signs a stablecoin authorization and retries with an `X-PAYMENT` header; the server verifies, settles on-chain, and serves the request. No accounts, no API keys, no subscriptions — pay per call.

## Installation

```bash
npm install @furlpay/x402
```

## Quickstart — Next.js App Router

```ts
// app/api/premium/route.ts
import { withX402 } from "@furlpay/x402";

export const GET = withX402(
  async () => Response.json({ data: "premium market signal" }),
  {
    payTo: "0xYourReceivingAddress",
    network: "base",          // or "solana"
    amount: "10000",          // atomic units of the asset; USDC has 6 decimals, so "10000" = $0.01
    description: "Premium data",
  }
);
```

Unpaid requests receive a `402` with the payment requirements in the body; paid requests are settled and served with an `X-PAYMENT-RESPONSE` receipt header.

## Quickstart — Express

```ts
import express from "express";
import { expressX402 } from "@furlpay/x402";

const app = express();

app.get(
  "/premium",
  expressX402({ payTo: "0xYourAddress", network: "base", amount: "10000" }),
  (req, res) => res.json({ data: "premium" })
);
```

## Framework-agnostic core

`gate()` implements the whole flow without any framework assumptions:

```ts
import { gate } from "@furlpay/x402";

const result = await gate(requestUrl, xPaymentHeaderOrNull, {
  payTo: "0xYourAddress",
  amount: "10000",
});

if (!result.paid) {
  // result.status is 402 (challenge) or 400 (malformed header)
  // result.body is the JSON to return
} else {
  // result.payer, result.transaction, result.settlementHeader
}
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `payTo` | `string` | — | Receiving address on the target network. Required. |
| `network` | `"base" \| "solana"` | `"base"` | Settlement network. |
| `asset` | `string` | USDC on the chosen network | Token contract / mint address. |
| `amount` | `string` | — | Price in atomic units of `asset` (USDC: 6 decimals). Required. |
| `description` | `string` | `"x402 payment"` | Human-readable description in the 402 challenge. |
| `facilitator` | `string \| Facilitator` | Furlpay hosted | Facilitator base URL, or your own `Facilitator` implementation (useful in tests). |
| `maxTimeoutSeconds` | `number` | `300` | How long the signed payment stays valid. |

## Facilitator client

Talk to any x402 facilitator's `supported` / `verify` / `settle` API directly:

```ts
import { useFacilitator, DEFAULT_FACILITATOR } from "@furlpay/x402";

const facilitator = useFacilitator();                     // hosted: https://furlpay.com/api/x402/facilitator
const local = useFacilitator("http://localhost:3000/api/x402/facilitator");

const { kinds } = await facilitator.supported();          // supported (scheme, network) pairs
const verdict = await facilitator.verify(payload, requirements);
const receipt = await facilitator.settle(payload, requirements);
```

`useFacilitator(baseUrl, fetchImpl)` accepts a custom fetch for proxies and tests.

## Requirements builder

`buildRequirements(resource, config)` produces the spec-shaped `PaymentRequirements` object (scheme `exact`, resolved asset, timeout) if you need to construct challenges manually.

## Security notes

The hardened server-side verifier used by the hosted facilitator defends the four published x402 attack classes: authorization (server-side truth for every field), binding (HMAC over resource + method + amount + expiry), replay (single-use nonces and quote ids), and web-layer handling (size-capped, fail-closed header parsing). See the [Furlpay security write-up](https://furlpay.com/blog/five-ways-to-rob-an-ai-agent-securing-x402) for details.

## Testing

The package ships a `node:test` suite covering the requirements builder, the 402/400/settlement paths of `gate`, the Next.js wrapper, and facilitator URL routing:

```bash
npm test
```

Inject a stub facilitator in your own tests via the `facilitator` option — no network needed.

## Related

- [furlpay-solana-actions-template](https://github.com/FurlPay/furlpay-solana-actions-template) — Solana Actions and Blinks starter
- [furlpay-node](https://github.com/FurlPay/furlpay-node) — the Furlpay API SDK
- [Documentation](https://furlpay.com/docs)

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md). Report vulnerabilities privately per [SECURITY.md](./SECURITY.md).

## License

MIT
