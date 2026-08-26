# opencode-go-quota-rotate

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

TBD — see [docs/architecture.md](docs/architecture.md) and [SESSION_RECORD.md](SESSION_RECORD.md) for the current implementation status.

## Usage

### Add accounts

TBD

### Check quota

```
opencode-go-quota-rotate quota
```

## Storage

| File | Purpose |
|---|---|
| `~/.config/opencode/opencode-go-accounts.json` | API keys, labels, enabled state |
| `~/.config/opencode/opencode-go-quota-rotation.json` | Last used account index |
| `~/.config/opencode/opencode-go-quota-rotate.log` | Plugin activity log |

## License

MIT
