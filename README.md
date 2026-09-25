# @furlpay/x402

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-000000?style=flat-square&logo=nextdotjs&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![Base](https://img.shields.io/badge/Base-0052FF?style=flat-square&logo=coinbase&logoColor=white)
![Arbitrum](https://img.shields.io/badge/Arbitrum-213147?style=flat-square&logo=arbitrum&logoColor=white)
![Solana](https://img.shields.io/badge/Solana-9945FF?style=flat-square&logo=solana&logoColor=white)
![x402](https://img.shields.io/badge/x402-0052FF?style=flat-square)
![USDC](https://img.shields.io/badge/USDC-2775CA?style=flat-square)

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

x402 payment middleware and facilitator client — gate any HTTP route behind a stablecoin micropayment in a few lines. Built on the [x402 protocol](https://www.x402.org/) (HTTP 402 "Payment Required" revived for machine-to-machine payments).

- Framework adapters for Next.js App Router and Express/Connect, plus a framework-agnostic core.
- Verification and on-chain settlement are delegated to a facilitator — the hosted Furlpay facilitator by default, or point at your own.
- USDC on Base and Solana resolved automatically; any SPL/ERC-20 asset via config.

### What settles, and what merely quotes

These are different capabilities and this README used to blur them:

| | Base | Arbitrum | Solana |
| --- | --- | --- | --- |
| Middleware can emit a 402 | yes | yes | yes |
| Hosted facilitator verifies + settles | yes | yes | **no** |

The middleware is chain-agnostic — `buildRequirements()` resolves the right USDC
asset and returns a well-formed 402 for any network you configure. Settlement is
delegated to a facilitator, and the hosted Furlpay facilitator verifies EIP-3009
authorizations by EIP-712 `ecrecover` (plus ERC-1271 for contract wallets). That
is an EVM mechanism. Solana uses a different signature scheme, so the verifier
returns `svm_verification_unavailable` rather than accepting something it has not
checked — it fails closed, but it does fail.

So: point the middleware at Solana if you are running a facilitator that can
settle SVM. If you are using the hosted default, use an EVM network.
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

### What this package checks itself

`gate()` verifies the presented payload against the requirements **it** built,
before forwarding anything to a facilitator:

| Checked locally | Refused when |
| --- | --- |
| `payTo` | the authorization is addressed to someone else |
| amount | `authorization.value < maxAmountRequired` (overpayment is fine) |
| `scheme` / `network` / `x402Version` | they differ from the challenge |
| validity window | expired, or not yet valid beyond a 5s skew allowance |
| shape | no signature, or no authorization object |

These hold even when the facilitator is wrong, misconfigured or hostile — which
matters because `facilitator` is a documented option, so "the hosted one" and
"any third party" are the same code path. A payment that fails them is **never
submitted for settlement**, so a mismatched payment does not move money on-chain
for a resource that is then refused.

`skipLocalVerification: true` restores the old delegate-everything behaviour for
a scheme this package cannot interpret. It is an escape hatch, not a tuning
knob: setting it makes any facilitator weakness a full bypass again.

Paid responses and 402 challenges are both stamped `Cache-Control: no-store,
private` and `Vary: X-PAYMENT`, so a CDN or reverse proxy cannot serve a paid
response to a later unpaid client.

### What still lives in the facilitator

Local checks are field checks. They are **not** a signature check, and **not** a
resource binding — the `exact` scheme's authorization carries no resource, so a
payment minted for resource A still satisfies every field of resource B on the
same server at the same price. Closing that needs a binding the payer signs
over (F1 in `@furlpay/x402-guard`), a nonce store for replay, and a
confirmation-depth policy. `gate()` keeps no nonce store of its own.

That distinction only matters if you change the facilitator — and the `facilitator`
option exists precisely so you can. Against the hosted Furlpay facilitator you get
the hardened verifier described below. Against your own deployment, or any third
party, you get exactly what that facilitator enforces, plus the local checks above.

The hardened server-side verifier used by the hosted facilitator defends the four
published x402 attack classes: authorization (server-side truth for every field),
binding (HMAC over resource + method + amount + expiry), replay (single-use nonces
and quote ids), and web-layer handling (size-capped, fail-closed header parsing).
See the [Furlpay security write-up](https://furlpay.com/blog/five-ways-to-rob-an-ai-agent-securing-x402)
for details.

### Self-hosting or using another facilitator

Add the defenses at your own edge:

- [`@furlpay/x402-guard`](https://github.com/FurlPay/x402-guard) — request binding (F1),
  atomic nonce linearization (F2), reserve-commit allowances (F3) and settlement
  capacity limits (F4), all failure-closed.
- [`@furlpay/settlement`](https://github.com/FurlPay/furlpay-settlement) — `assessSettlement`
  decides whether an observed on-chain state is strong enough to release, given the
  amount at risk. A `SettleResponse` reporting `success` says a transaction exists; it
  does not say the transaction is irreversible.

Neither is a dependency of this package, so neither is applied unless you wire it in.

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
