/**
 * ALL PRICING LIVES HERE. Change a price in this file and the x402
 * payment requirements (the 402 challenge) update automatically.
 *
 * Prices are dollar strings; the x402 SDK converts them to the network's
 * default USDC asset (6 decimals) for the configured network.
 */
export const PRICES = {
  /** POST /v1/read — fetch a URL, return clean article text */
  read: "$0.03",
  /** POST /v1/convert — markdown/HTML/text/JSON/CSV conversion */
  convert: "$0.02",
} as const;

export type PricedRoute = keyof typeof PRICES;
