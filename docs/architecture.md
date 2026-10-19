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

## Pi adapter

`src/pi.ts` holds the host-neutral half (account loading, quota caching, failure
classification, cooldown, ranking); `src/pi-extension.ts` is the thin Pi binding
that registers the `opencode-pool` provider and the `/pool` command.

```
┌──────────────────────┐
│ pi-extension.ts      │  Pi extension API: registerProvider, /pool
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ pi.ts                │  accounts · quota cache · classifyFailure · cooldown
└────┬────────────┬────┘
     │            │
┌────▼─────┐ ┌────▼────┐
│ rotate.ts│ │ quota.ts│  shared with the OpenCode plugin
└──────────┘ └─────────┘
```

Two Pi-specific constraints shape this split:

1. **Pi loads extension files directly with jiti.** It cannot resolve this
   repository's `src/*.ts`, so `npm run build:pi` bundles everything into one
   file. `@earendil-works/*` stays external: Pi resolves those from its own
   install.
2. **The per-API stream wrappers live on the compat entrypoint.** The root
   `@earendil-works/pi-ai` entrypoint exports only `lazyApi`/`lazyStream`;
   `anthropicMessagesApi` and friends come from `@earendil-works/pi-ai/compat`.

Rotation happens before the first stream event is yielded. Once any content has
reached the caller, a failure is surfaced as-is: replaying the request would
duplicate output.

The quota lookup is injectable (`setQuotaLookup`) so tests never reach the
network.

### Startup default model

`settings.json` cannot reliably point `defaultProvider` at an
extension-registered provider: `createAgentSession()` resolves the startup model
with `findInitialModel()` before the extension runner binds its context, so the
provider lookup misses and Pi falls back to a built-in provider default without
any error. The extension closes that gap on `session_start`:

- acts only for `reason` `startup` / `new`, so `resume` and `fork` keep the model
  recorded in the session (that is the user's own choice);
- acts only when `settings.defaultProvider` names this provider, so it never
  overrides a different configured default;
- on a missing model or a not-ready pool it notifies and leaves the current model
  in place instead of failing the session.

### Build

```
npm run build:pi   # -> dist/pi-extension.js (self-contained, copy into Pi)
```

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
