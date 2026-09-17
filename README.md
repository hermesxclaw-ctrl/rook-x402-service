# rook-x402-service

x402-gated paid microservice: URL reader + format converter. Agents pay per call in USDC on Base.

- `GET /v1/health` — free, shows config + prices
- `POST /v1/read` — $0.03, fetch a URL, return clean article text
- `POST /v1/convert` — $0.02, convert between markdown / HTML / text / JSON / CSV

Default network: Base Sepolia testnet (`eip155:84532`) via the public x402.org facilitator.
Set `X402_PAY_TO` env var to the receiving wallet address. No private keys on the server.
