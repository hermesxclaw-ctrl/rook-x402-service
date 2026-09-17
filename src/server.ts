import express from "express";
import { convert, FORMATS, type Format } from "./convert.js";
import { readUrl } from "./read.js";
import { describeConfig, mountX402 } from "./x402.js";


const PORT = Number(process.env.PORT ?? 3000);
const app = express();
// Behind Render's reverse proxy: respect X-Forwarded-Proto so the x402
// middleware advertises https:// resource URLs (required for Bazaar).
app.set("trust proxy", 1);


app.use(express.json({ limit: "2mb" }));


// ---- Free routes (registered BEFORE the x402 gate) ----
app.get("/v1/health", (_req, res) => {
  res.json({
    ok: true,
    service: "rook-x402-microservice",
    version: "0.1.0",
    time: new Date().toISOString(),
    x402: describeConfig(),
    endpoints: {
      "GET /v1/health": { price: "free" },
      "POST /v1/read": { price: "$0.03 — fetch URL, return clean article text" },
      "POST /v1/convert": { price: "$0.02 — markdown/HTML/text/JSON/CSV conversion" },
    },
  });
});


// ---- x402 payment gate: everything below requires a paid USDC authorization ----
mountX402(app);


// ---- Paid route handlers (run only after payment verifies + settles) ----
app.post("/v1/read", async (req, res) => {
  try {
    const { url, maxChars } = req.body ?? {};
    if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
      res.status(400).json({ error: 'body must include { url: string }' });
      return;
    }
    const mc =
      maxChars === undefined ? undefined : Math.min(Math.max(Number(maxChars) || 0, 100), 100_000);
    const result = await readUrl(url, mc);
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "read failed" });
  }
});


app.post("/v1/convert", (req, res) => {
  try {
    const { from, to, input } = req.body ?? {};
    if (!FORMATS.includes(from) || !FORMATS.includes(to)) {
      res.status(400).json({
        error: `from/to must be one of: ${FORMATS.join(", ")}`,
      });
      return;
    }
    if (typeof input !== "string") {
      res.status(400).json({ error: "body must include { from, to, input: string }" });
      return;
    }
    res.json({ from, to, output: convert(from as Format, to as Format, input) });
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "convert failed" });
  }
});


app.use((_req, res) => res.status(404).json({ error: "not found" }));


app.listen(PORT, () => {
  console.log(`[service] listening on :${PORT}`);
  console.log(`[service] x402 config:`, JSON.stringify(describeConfig(), null, 2));
});
