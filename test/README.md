# Tests

Unit tests for the plugin and CLI, run with `npm test`:

```sh
npm test          # node --test: picks up test/*.test.ts
npm run typecheck # tsc --noEmit
```

Coverage:

- `rotate.ts` — account selection: expiry-aware scoring, usable-account filter,
  round-robin tie-break, failed-lookup handling
- `fetch.ts` — failover on 429 / 401 / quota-error responses, passthrough
- `quota.ts` — usage API parsing and window normalization
- `storage.ts` — accounts file read/write and corruption handling
- `logger.ts` — log routing (see below)
- `confirm.ts` / `display.ts` — the `remove` confirmation prompt

## Tests must not touch real files

Nothing here may read or write the user's `~/.config/opencode`. Tests achieve
that by pointing `process.env.HOME` at a temporary directory (`storage.test.ts`
does this per test) or `OPENCODE_GO_LOG_FILE` at a temp file (`logger.test.ts`).

`src/logger.ts` additionally refuses to log at all inside a test process —
`node --test` marks its children with `NODE_TEST_CONTEXT`, and that check is what
stops a suite from appending to a developer's real plugin log. A test that wants
to assert on log output opts back in with `OPENCODE_GO_LOG_FILE`.
