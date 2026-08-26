# Architecture

`opencode-go-quota-rotate` is an OpenCode plugin that performs quota-aware rotation across multiple OpenCode Go API keys.

## Overview

```
┌─────────────┐     ┌──────────────┐     ┌───────────┐
│  index.ts   │────▶│   rotate.ts  │────▶│  quota.ts │──▶ OpenCode Go
│  (Plugin)   │     │ (selection)  │     │ (usage API)│    usage API
└──────┬──────┘     └──────┬───────┘     └───────────┘
       │                   │
       ├────▶ storage.ts ──┘   (accounts + rotation state on disk)
       │
       ├────▶ fetch.ts         (request-level failover wrapper)
       │
       └────▶ cli.ts           (CLI: list / status / add / remove / quota)
```

## Plugin auth contract (verified against OpenCode 1.18.23)

OpenCode resolves request authentication through plugin-provided auth hooks. The
critical mechanics (verified empirically):

1. **Auth provider id must match the request's provider.** Requests for paid Go
   models (e.g. `opencode-go/mimo-v2.5`) resolve auth via the `opencode-go`
   provider id. The plugin must register `auth.provider = "opencode-go"`.
   (Registering `"opencode"` only affects the free Zen provider and is the
   reason similar plugins appear inert for Go subscription traffic.)
2. **A stored credential must already exist in `auth.json` for that provider**
   for the plugin loader to be consulted. The loader keeps it fresh via
   `client.auth.set`.
3. **The loader's returned `fetch` wrapper is used by OpenCode for matching
   requests**, which is where per-request failover happens.

## Account selection

The loader picks the best account by live quota:

- For every enabled account, query `GET https://opencode.ai/zen/go/v1/usage`
  (cache for a few minutes).
- Score accounts: weekly usage percent dominates, rolling percent breaks ties;
  a rate-limited (100%) weekly window is heavily penalized.
- Pick the lowest score; fall back to round-robin when the usage API is
  unreachable.

## Request-level failover

The `fetch` wrapper signs requests with the active account key and inspects
responses. On HTTP 429, or on 402/403/409/5xx responses whose body mentions
quota/rate-limit/balance, the account is marked exhausted and the request is
retried with the next account. When every account is exhausted, a 429 response
is returned.

## Usage API contract

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <api-key>
Accept: application/json
```

```json
{
  "usage": {
    "rolling":  { "status": "ok", "percent": 14, "resetsAt": "2026-08-26T11:10:18.818Z" },
    "weekly":   { "status": "ok", "percent": 1,  "resetsAt": "2026-08-31T00:00:00.118Z" },
    "monthly":  { "status": "ok", "percent": 0,  "resetsAt": "2026-09-25T06:29:26.118Z" }
  }
}
```

`percent` is the used percentage (0–100); `status` is `ok` or `rate-limited`.

## Build

The plugin entry is bundled to a single ESM file (`dist/index.js`); the CLI is
bundled to CommonJS (`dist/cli.cjs`) so it runs under plain Node without Bun.

```
npm install
npm run build
```

## Tests

```
npm test
```
