import type { GoAccount } from "./types"

// TODO(impl): request-level rotating fetch with quota-aware failover.
//
// Behavior:
// 1. Sign each request with the active account's key:
//      headers.delete("authorization"); headers.set("Authorization", "Bearer <key>")
// 2. Inspect the response. Fail over to the next account when:
//      - status === 429, or
//      - status in {402, 403, 409} or >= 500, AND the body matches
//        /(rate\s*limit|usage\s*limit|quota|insufficient\s+balance|balance|limit\s+reached|too\s+many\s+requests)/i
// 3. When failing over, mark the account exhausted, pick the next best
//    (non-exhausted, non-quota-blocked) account, and retry the same request.
// 4. If every account is exhausted, return a synthetic 429 Response.
// 5. Never consume the response body for non-error responses (clone before reading).

export function createRotatingFetch(accounts: GoAccount[]): { fetch: typeof globalThis.fetch } {
  void accounts
  throw new Error("not implemented")
}
