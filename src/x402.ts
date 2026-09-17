import { HTTPFacilitatorClient, RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import type { Express } from "express";
import { PRICES } from "./pricing.js";

/**
 * x402 (HTTP 402 stablecoin payments) wiring. Testnet default: Base Sepolia.
 * No wallet or private key lives on this server. It only ADVERTISES a payTo
 * address; the facilitator moves the funds.
 */

export const NETWORK: Network = (process.env.X402_NETWORK ?? "eip155:84532") as Network; // Base Sepolia testnet
export const FACILITATOR_URL =
  process.env.FACILITATOR_URL ?? "https://x402.org/facilitator"; // public testnet facilitator, no account needed

const PLACEHOLDER_PAYTO = "0x000000000000000000000000000000000000dEaD";
export const PAY_TO = process.env.X402_PAY_TO ?? PLACEHOLDER_PAYTO;

if (!process.env.X402_PAY_TO) {
  console.warn(
    "[x402] WARNING: X402_PAY_TO is not set — advertising placeholder address " +
      PLACEHOLDER_PAYTO +
      ". Set X402_PAY_TO to your Base wallet address before accepting real payments.",
  );
}

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const resourceServer = new x402ResourceServer(facilitator);
registerExactEvmScheme(resourceServer, { networks: [NETWORK] });

const routes: RoutesConfig = {
  "POST /v1/read": {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      price: PRICES.read,
      payTo: PAY_TO,
    },
    description:
      "Fetch a URL and return clean article text (readability extraction: title, byline, text). Body: { url: string, maxChars?: number }.",
    mimeType: "application/json",
  },
  "POST /v1/convert": {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      price: PRICES.convert,
      payTo: PAY_TO,
    },
    description:
      "Convert between markdown, HTML, plain text, JSON and CSV. Body: { from, to, input }.",
    mimeType: "application/json",
  },
};

const httpServer = new x402HTTPResourceServer(resourceServer, routes);

export function mountX402(app: Express): void {
  app.use(paymentMiddlewareFromHTTPServer(httpServer));
}

export function describeConfig() {
  return {
    network: NETWORK,
    facilitator: FACILITATOR_URL,
    payTo: PAY_TO,
    prices: { ...PRICES },
  };
}
