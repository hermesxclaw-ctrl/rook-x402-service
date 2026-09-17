import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { HTTPFacilitatorClient, RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import type { Express } from "express";
import { PRICES } from "./pricing.js";

export const NETWORK: Network = (process.env.X402_NETWORK ?? "eip155:84532") as Network;

export const FACILITATOR_URL =
  process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";

const PLACEHOLDER_PAYTO = "0x000000000000000000000000000000000000dEaD";

export const PAY_TO = process.env.X402_PAY_TO ?? PLACEHOLDER_PAYTO;

if (!process.env.X402_PAY_TO) {
  console.warn(
    "[x402] WARNING: X402_PAY_TO is not set — advertising placeholder address " +
      PLACEHOLDER_PAYTO +
      ". Set X402_PAY_TO to your Base wallet address before accepting real payments.",
  );
}

/**
 * CDP facilitator authentication.
 *
 * The CDP facilitator (https://api.cdp.coinbase.com/platform/v2/x402) requires
 * a JWT signed with the CDP Secret API key (Ed25519) on every request. Claims
 * follow CDP's API-key auth spec: iss "cdp", sub = key id,
 * uri = "<METHOD> api.cdp.coinbase.com<path>".
 *
 * Settling through the CDP facilitator is what indexes this service in the
 * CDP Bazaar catalog. The public x402.org facilitator needs no auth.
 */
const CDP_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET; // base64 "privateKey" from the CDP portal JSON
const USE_CDP_AUTH =
  FACILITATOR_URL.includes("api.cdp.coinbase.com") && !!CDP_KEY_ID && !!CDP_KEY_SECRET;

function cdpPrivateKey() {
  const raw = Buffer.from(CDP_KEY_SECRET as string, "base64");
  if (raw.length === 48 && raw[0] === 0x30) {
    return createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
  }
  let seed: Buffer;
  if (raw.length === 64) seed = raw.subarray(0, 32); // seed || pubkey
  else if (raw.length === 32) seed = raw;
  else throw new Error(`[x402] unexpected CDP_API_KEY_SECRET length: ${raw.length}`);
  return createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
}

function cdpJwt(method: string, path: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = {
    alg: "EdDSA",
    kid: CDP_KEY_ID,
    nonce: randomUUID().replace(/-/g, ""),
    typ: "JWT",
  };
  const payload = {
    iss: "cdp",
    sub: CDP_KEY_ID,
    nbf: now,
    exp: now + 120,
    uri: `${method} api.cdp.coinbase.com${path}`,
  };
  const data = `${b64u(header)}.${b64u(payload)}`;
  const sig = sign(null, Buffer.from(data), cdpPrivateKey());
  return `${data}.${sig.toString("base64url")}`;
}

const facilitator = new HTTPFacilitatorClient({
  url: FACILITATOR_URL,
  ...(USE_CDP_AUTH
    ? {
        createAuthHeaders: async () => {
          const base = "/platform/v2/x402";
          return {
            verify: { Authorization: `Bearer ${cdpJwt("POST", `${base}/verify`)}` },
            settle: { Authorization: `Bearer ${cdpJwt("POST", `${base}/settle`)}` },
            supported: { Authorization: `Bearer ${cdpJwt("GET", `${base}/supported`)}` },
          };
        },
      }
    : {}),
});

if (USE_CDP_AUTH) {
  console.log("[x402] CDP facilitator auth enabled (signed JWT per request)");
}

const resourceServer = new x402ResourceServer(facilitator);

resourceServer.registerExtension(bazaarResourceServerExtension);
registerExactEvmScheme(resourceServer, { networks: [NETWORK] });

const readDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { url: "https://example.com/article", maxChars: 20000 },
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Public http(s) URL to fetch and extract article text from.",
      },
      maxChars: {
        type: "number",
        description: "Max characters of extracted text to return (100-100000, default 20000).",
      },
    },
    required: ["url"],
  },
  output: {
    example: {
      url: "https://example.com/article",
      finalUrl: "https://example.com/article",
      title: "Example article",
      byline: null,
      siteName: "Example",
      text: "Article text...",
      charCount: 15,
      truncated: false,
    },
  },
});

const convertDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { from: "html", to: "markdown", input: "<h1>Hello</h1>" },
  inputSchema: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "Source format: markdown, html, text, json or csv.",
      },
      to: {
        type: "string",
        description: "Target format: markdown, html, text, json or csv.",
      },
      input: { type: "string", description: "Content to convert." },
    },
    required: ["from", "to", "input"],
  },
  output: {
    example: { from: "html", to: "markdown", output: "# Hello" },
  },
});

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
    serviceName: "Rook Reader",
    tags: ["web", "article", "extract", "text"],
    extensions: readDiscovery,
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
    serviceName: "Rook Convert",
    tags: ["convert", "markdown", "html", "csv", "json"],
    extensions: convertDiscovery,
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
