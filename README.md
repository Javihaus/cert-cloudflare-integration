# CERT + Cloudflare AI Gateway Integration

This Cloudflare Worker demonstrates CERT operating as a hallucination detection
sidecar alongside Cloudflare AI Gateway.

## What it does

Every LLM call forwarded through this worker is:
1. Sent to Cloudflare AI Gateway unchanged (zero latency impact)
2. Asynchronously logged to CERT for grounding evaluation via `ctx.waitUntil()`
3. Returned with `X-CERT-Grounding-Pending: true` header

Grounding scores (SGI/DGI) appear in the CERT dashboard within seconds.

## Deploy

```bash
cd integrations/cloudflare
npm install
wrangler secret put CERT_API_KEY
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_GATEWAY_ID
wrangler deploy
```

## Usage

Change your OpenAI base URL from:
```
https://api.openai.com/v1
```
To:
```
https://cert-gateway-demo.{your-subdomain}.workers.dev/openai/v1
```

All existing API calls work unchanged. CERT grounding scores accumulate
in your dashboard automatically.
