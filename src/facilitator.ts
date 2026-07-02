import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
} from "./types";

// The hosted Furlpay facilitator — the first Solana-native x402 facilitator,
// also supporting Base. Point at your own deployment to self-host.
export const DEFAULT_FACILITATOR = "https://furlpay.com/api/x402/facilitator";

export interface Facilitator {
  supported(): Promise<{ kinds: SupportedKind[] }>;
  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse>;
}

/**
 * Client for an x402 facilitator's verify/settle/supported API.
 *
 * @example
 *   const facilitator = useFacilitator();               // Furlpay hosted
 *   const facilitator = useFacilitator("http://localhost:3000/api/x402/facilitator");
 */
export function useFacilitator(baseUrl: string = DEFAULT_FACILITATOR, fetchImpl: typeof fetch = fetch): Facilitator {
  const base = baseUrl.replace(/\/$/, "");

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

  return {
    async supported() {
      const res = await fetchImpl(`${base}/supported`);
      return (await res.json()) as { kinds: SupportedKind[] };
    },
    verify(paymentPayload, paymentRequirements) {
      return post<VerifyResponse>("/verify", {
        x402Version: paymentPayload.x402Version,
        paymentPayload,
        paymentRequirements,
      });
    },
    settle(paymentPayload, paymentRequirements) {
      return post<SettleResponse>("/settle", {
        x402Version: paymentPayload.x402Version,
        paymentPayload,
        paymentRequirements,
      });
    },
  };
}
