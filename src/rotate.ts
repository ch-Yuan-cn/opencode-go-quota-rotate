import { queryQuota } from "./quota.ts"
import type { GoAccount, QuotaInfo } from "./types.ts"

/**
 * Quota-aware account selection.
 *
 * Scoring:
 *   score = weekly.percent * 10 + rolling.percent
 *   weekly rate-limited (status "rate-limited" or percent >= 100):
 *     score = 1000 + rolling.percent  (heavy penalty so exhausted accounts sink)
 *   Lowest score wins; ties resolve in round-robin order after the last used
 *   index. If every quota query fails, fall back to plain round-robin.
 */

const CACHE_MS = 5 * 60 * 1000
const quotaCache = new Map<string, QuotaInfo>()

export function isWeeklyExhausted(q: QuotaInfo | undefined): boolean {
  const w = q?.weekly
  if (!w) return false
  return w.status === "rate-limited" || w.percent >= 100
}

/** Cached quota lookup (5 minutes), so repeated loaders don't hammer the API. */
export async function getQuotaCached(apiKey: string): Promise<QuotaInfo> {
  const hit = quotaCache.get(apiKey)
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit
  const fresh = await queryQuota(apiKey)
  quotaCache.set(apiKey, fresh)
  return fresh
}

/** Score one account; lower is better. */
export function scoreAccount(q: QuotaInfo | undefined): number {
  if (!q) return Number.POSITIVE_INFINITY
  const rolling = q.rolling?.percent ?? 0
  const weekly = q.weekly?.percent ?? 0
  if (isWeeklyExhausted(q)) return 1000 + rolling
  return weekly * 10 + rolling
}

export class NoEnabledAccounts extends Error {
  constructor() {
    super("no enabled Go accounts configured")
    this.name = "NoEnabledAccounts"
  }
}

/**
 * Pick the best account. Returns the account, its index, the quota used for
 * scoring (when available) and the reason for the choice.
 */
export async function pickAccount(
  accounts: GoAccount[],
  lastIndex: number,
): Promise<{ account: GoAccount; index: number; quota?: QuotaInfo; reason: string }> {
  const enabled = accounts
    .map((a, i) => ({ account: a, index: i }))
    .filter((e) => e.account.enabled)
  if (enabled.length === 0) throw new NoEnabledAccounts()

  // Quota lookups run in parallel; failures are tolerated per account.
  const withQuota = await Promise.all(
    enabled.map(async (e) => ({ ...e, quota: await getQuotaCached(e.account.apiKey) })),
  )

  const known = withQuota.filter((e) => !e.quota.error)
  if (known.length > 0) {
    // Rotation-order candidates starting after the last used index.
    const order = enabled.map((e) => e.index)
    const start = lastIndex >= 0 ? order.findIndex((i) => i > lastIndex) : 0
    const rotated = start === -1
      ? order
      : [...order.slice(start), ...order.slice(0, start)]

    let best: { account: GoAccount; index: number; quota?: QuotaInfo; reason: string } | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const idx of rotated) {
      const e = withQuota.find((x) => x.index === idx)!
      const score = scoreAccount(e.quota)
      if (score < bestScore) {
        bestScore = score
        best = {
          account: e.account,
          index: e.index,
          quota: e.quota,
          reason: isWeeklyExhausted(e.quota) ? "weekly quota exhausted" : "quota-aware",
        }
      }
    }
    if (best) return best
  }

  // Fallback: every quota query failed -> plain round-robin.
  const total = enabled.length
  for (let i = 1; i <= total; i++) {
    const candidate = enabled[(lastIndex + i) % total]
    return { account: candidate.account, index: candidate.index, reason: "round-robin (quota API unavailable)" }
  }
  throw new NoEnabledAccounts()
}