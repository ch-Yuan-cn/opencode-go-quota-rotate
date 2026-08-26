import type { GoAccount, QuotaInfo } from "./types"

// TODO(impl): quota-aware account selection.
//
// Selection rules (see docs/architecture.md):
// 1. For every enabled account, fetch quota via getQuotaCached(apiKey).
// 2. Score = weekly.percent * 10 + rolling.percent; if weekly is
//    rate-limited (status === "rate-limited" or percent >= 100) use
//    1000 + rolling.percent so exhausted accounts are deprioritized.
// 3. Pick the lowest score; among equal scores, prefer the account after the
//    last used index (round-robin tiebreak).
// 4. If every quota query fails (network/API down), fall back to plain
//    round-robin over enabled accounts.
//
// Cache quota results in memory for ~5 minutes.

const CACHE_MS = 5 * 60 * 1000
const quotaCache = new Map<string, QuotaInfo>()

export async function getQuotaCached(apiKey: string): Promise<QuotaInfo> {
  void apiKey
  return { fetchedAt: Date.now(), error: "not implemented" }
}

export async function pickAccount(
  accounts: GoAccount[],
  lastIndex: number,
): Promise<{ account: GoAccount; index: number; quota?: QuotaInfo; reason: string }> {
  void lastIndex
  void accounts
  throw new Error("not implemented")
}
