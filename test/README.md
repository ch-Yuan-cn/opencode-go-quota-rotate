# Tests

Placeholder. Tests will cover:

- `quota.ts` — usage API response parsing and window normalization
- `rotate.ts` — account selection scoring and round-robin fallback
- `fetch.ts` — failover logic on 429 / quota-error responses
- `storage.ts` — accounts file read/write and corruption handling

Run with `npm test` (`node --test test/`).
