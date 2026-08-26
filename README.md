# opencode-go-quota-rotate

[![CI](https://github.com/ch-Yuan-cn/opencode-go-quota-rotate/actions/workflows/ci.yml/badge.svg)](https://github.com/ch-Yuan-cn/opencode-go-quota-rotate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Quota-aware multi-account rotation for the [OpenCode](https://opencode.ai) Go subscription.

Run multiple OpenCode Go API keys side by side. On every session the plugin queries each account's live usage quota and picks the account with the most remaining capacity. When the active account hits its quota mid-session — HTTP 429, rate limits, or quota/balance errors — the plugin fails over to the next account automatically.

## Why this plugin

The official Go subscription limits usage per key on rolling, weekly, and monthly windows. A single key can exhaust its weekly allowance while other keys still have capacity. This plugin:

- **Monitors quota proactively** — reads live usage from the OpenCode Go usage API for every configured key before choosing an account.
- **Rotates accounts** — one account per OpenCode process, round-robin across processes, quota-aware.
- **Fails over reactively** — detects quota exhaustion on live requests (429 / rate-limit / quota / balance errors) and retries with the next account in the same process.

## Features

- Quota-aware account selection (rolling 5h / weekly / monthly windows)
- Automatic failover on quota exhaustion
- Per-process account stickiness (preserves token caches)
- CLI account management and quota monitoring
- Persistent state (accounts and rotation position survive restarts)
- No modifications to OpenCode — installs as a plugin

## Requirements

- OpenCode 1.18.x (Go subscription)
- Node.js 18+ (for the CLI and local build)

## Installation

### 1. Build the plugin

```sh
git clone https://github.com/ch-Yuan-cn/opencode-go-quota-rotate.git
cd opencode-go-quota-rotate
npm install
npm run build   # produces dist/index.js (plugin) and dist/cli.cjs (CLI)
```

### 2. Register the plugin with OpenCode

Add the project's absolute path to the `plugin` array in
`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "/absolute/path/to/opencode-go-quota-rotate"
  ]
}
```

Restart OpenCode (CLI and desktop), then confirm the plugin is picked up:

```sh
opencode debug config   # the plugin path should appear in "plugin"
```

### 3. Prerequisite: an existing `opencode-go` credential

OpenCode 1.18.x only consults a plugin's auth loader when a credential for
that provider already exists. Make sure `~/.local/share/opencode/auth.json`
contains an `opencode-go` entry (any valid Go API key, e.g. added via
`opencode auth login`). The loader keeps this entry fresh on every session.

## Usage

The plugin needs at least one enabled account. Add keys either with the CLI or
through OpenCode's built-in auth flow (`/login` → `Add Go Account`).

### CLI

```sh
# From the plugin directory (or install globally with `npm i -g .`):
node dist/cli.cjs add -k sk-xxxx -l "account 1"    # add an account
node dist/cli.cjs list                             # list accounts (marks current)
node dist/cli.cjs status                           # rotation position
node dist/cli.cjs remove 2                         # remove by 1-based number
node dist/cli.cjs quota                            # live rolling/weekly/monthly usage
```

### Check quota

```
node dist/cli.cjs quota
```

Example output:

```
账号1 sk-LtMF...MpBC
  rolling: 14% ok (resets 2026-08-26T11:10:18.330Z)
  weekly: 100% rate-limited (resets 2026-08-31T00:00:00.330Z)
  monthly: 77% ok (resets 2026-09-20T03:42:10.330Z)
账号2 sk-zq0j...pAqm
  rolling: 2% ok (resets 2026-08-26T14:41:01.115Z)
  weekly: 1% ok (resets 2026-08-31T00:00:00.115Z)
  monthly: 0% ok (resets 2026-09-25T06:29:26.115Z)
```

### How account selection works

On every session the loader queries the OpenCode Go usage API
(`GET https://opencode.ai/zen/go/v1/usage`, the same endpoint used by
`@slkiser/opencode-quota`, so both can coexist) for each enabled key and
scores them:

- `score = weekly.percent * 10 + rolling.percent`
- a rate-limited (or 100%) weekly window is heavily penalized
  (`1000 + rolling.percent`)
- the lowest score wins; ties break in rotation order
- if the usage API is unreachable, selection falls back to plain round-robin

Mid-session, if the active account returns HTTP 429 — or a 402/403/409/5xx
whose body mentions rate limits, quota, or insufficient balance — the account
is marked exhausted and the same request is retried with the next account.
When every account is exhausted, a synthetic 429 is returned.

## Storage

| File | Purpose |
|---|---|
| `~/.config/opencode/opencode-go-accounts.json` | API keys, labels, enabled state |
| `~/.config/opencode/opencode-go-quota-rotation.json` | Last used account index |
| `~/.config/opencode/opencode-go-quota-rotate.log` | Plugin activity log |

## License

MIT