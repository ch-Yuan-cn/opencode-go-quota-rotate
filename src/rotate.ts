import { queryQuota } from "./quota.ts"
import type { GoAccount, QuotaInfo, QuotaWindow } from "./types.ts"

/**
 * Quota-aware account selection.
 *
 * Two forces decide the pick, in this order:
 *
 * 1. **Usability.** An account with any window already full (status
 *    `rate-limited` or percent >= 100) cannot serve a request right now, so it
 *    is only used when no account is usable at all.
 * 2. **Expiring headroom first.** Quota only counts if it is spent before its
 *    window resets, so an account whose remaining allowance is about to be
 *    reset is preferred over one that has a whole window left:
 *
 *        wasteRisk = headroom% / hours until reset
 *
 *    The highest wasteRisk wins; the scarcity score below breaks ties.
 *
 * Only the **weekly and monthly** windows are allowance windows at all: the
 * rolling window is a rate limit (~5h, and it slides forward whether or not you
 * use it), so unused rolling quota is not "lost" and gives no reason to prefer
 * an account.
 *
 * Of those two, only a window whose reset **differs between candidates** can
 * order them — a shared boundary wastes everyone's unused headroom at the same
 * instant, so it cannot make one account more urgent than another. That test is
 * applied per selection ({@link discriminatingWindows}) rather than hard-coding
 * a window name, because which windows are shared is the provider's business:
 * measured live, the weekly window is a shared calendar boundary while the
 * monthly window follows each account's subscription date.
 *
 * Scarcity score (lower is better) — used to break equal-wasteRisk ties and to
 * pick the least-bad account when everything is full:
 *
 *   score = weekly.percent * 10 + rolling.percent
 *   any window full: 2000 (rolling) / 3000 (weekly) / 4000 (monthly) + rolling
 *
 * The penalties are ordered by how long that window takes to come back, and all
 * sit strictly above the highest healthy score (99 * 10 + 99 = 1089), so a full
 * window can never outrank a usable account.
 */

const CACHE_MS = 5 * 60 * 1000
const quotaCache = new Map<string, QuotaInfo>()

/** Windows that carry an allowance you can lose by not spending it. */
export const ALLOWANCE_WINDOWS = ["weekly", "monthly"] as const
export type AllowanceWindow = (typeof ALLOWANCE_WINDOWS)[number]

/** Clamp for a nearly-elapsed window so wasteRisk cannot divide by ~0. */
const MIN_HOURS_TO_RESET = 0.25

/** Two wasteRisk values within this are treated as equal, so float noise cannot flip the pick. */
const RISK_EPSILON = 1e-6

const ROLLING_FULL_PENALTY = 2000
const WEEKLY_FULL_PENALTY = 3000
const MONTHLY_FULL_PENALTY = 4000

/** One window is full: rate-limited, or 100% used. */
export function isWindowExhausted(w: QuotaWindow | undefined): boolean {
  if (!w) return false
  return w.status === "rate-limited" || w.percent >= 100
}

export function isWeeklyExhausted(q: QuotaInfo | undefined): boolean {
  return isWindowExhausted(q?.weekly)
}

/** An account can serve a request now: every window still has room. */
export function isAccountUsable(q: QuotaInfo | undefined): boolean {
  if (!q || q.error) return false
  return !isWindowExhausted(q.rolling) && !isWindowExhausted(q.weekly) && !isWindowExhausted(q.monthly)
}

/** Cached quota lookup (5 minutes), so repeated loaders don't hammer the API. */
export async function getQuotaCached(apiKey: string): Promise<QuotaInfo> {
  const hit = quotaCache.get(apiKey)
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit
  const fresh = await queryQuota(apiKey)
  quotaCache.set(apiKey, fresh)
  return fresh
}

/**
 * How much of this account's allowance is about to be lost: the largest
 * `headroom% / hours until reset` across `windows`. 0 means "no known window is
 * expiring", which also covers a failed lookup and a missing `resetsAt` — an
 * unknown window is not a reason to prefer an account.
 *
 * `windows` defaults to every allowance window, which is what a standalone
 * "how urgent is this account" display wants. Selection passes the narrower
 * {@link discriminatingWindows} set instead; see there for why.
 */
export function wasteRisk(
  q: QuotaInfo | undefined,
  now: number = Date.now(),
  windows: readonly AllowanceWindow[] = ALLOWANCE_WINDOWS,
): number {
  if (!q || q.error) return 0
  let risk = 0
  for (const name of windows) {
    const w = q[name]
    if (!w || isWindowExhausted(w)) continue
    const headroom = Math.max(0, 100 - w.percent)
    if (headroom <= 0) continue
    const resetsAt = Date.parse(w.resetsAt)
    if (!Number.isFinite(resetsAt)) continue
    const hours = Math.max((resetsAt - now) / 3_600_000, MIN_HOURS_TO_RESET)
    const candidate = headroom / hours
    if (candidate > risk) risk = candidate
  }
  return risk
}

/**
 * The allowance windows whose reset is **not** shared by every candidate.
 *
 * A window that comes back for all accounts at the same instant creates no
 * *differential* waste: whichever account you spend, that account's unused
 * headroom would have been lost at the same moment as every other account's, so
 * the window gives no reason to prefer one account over another.
 *
 * Measured live (2026-09-24): the weekly window is a shared calendar boundary —
 * every account reported the same reset, Monday 00:00 UTC, 92.9h out — while the
 * monthly window follows each account's own subscription date (27.4h vs 703.4h).
 * Counting the weekly window therefore just re-derived "the emptiest account
 * wins" (its headroom is ~10x the monthly one over a horizon ~8x shorter) and
 * drowned out the monthly signal that this feature exists to read.
 */
export function discriminatingWindows(
  quotas: readonly (QuotaInfo | undefined)[],
): readonly AllowanceWindow[] {
  if (quotas.length < 2) return []
  return ALLOWANCE_WINDOWS.filter((name) => {
    const resets = new Set<string>()
    for (const q of quotas) {
      if (!q || q.error) continue
      const t = Date.parse(q[name]?.resetsAt ?? "")
      if (Number.isFinite(t)) resets.add(new Date(t).toISOString())
    }
    return resets.size > 1
  })
}

/**
 * Scarcity score; lower is better. A failed quota lookup is **unknown**, not
 * perfect: `queryQuota` returns a truthy `{ error, fetchedAt }`, so guarding
 * only on `!q` once let a failed lookup fall through and score 0 — the best
 * possible score — which made a revoked key win every rotation.
 */
export function scoreAccount(q: QuotaInfo | undefined): number {
  if (!q || q.error) return Number.POSITIVE_INFINITY
  const rolling = q.rolling?.percent ?? 0
  const weekly = q.weekly?.percent ?? 0
  if (isWindowExhausted(q.monthly)) return MONTHLY_FULL_PENALTY + rolling
  if (isWindowExhausted(q.weekly)) return WEEKLY_FULL_PENALTY + rolling
  if (isWindowExhausted(q.rolling)) return ROLLING_FULL_PENALTY + rolling
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
  now: number = Date.now(),
): Promise<{ account: GoAccount; index: number; quota?: QuotaInfo; reason: string }> {
  const enabled = accounts
    .map((a, i) => ({ account: a, index: i }))
    .filter((e) => e.account.enabled)
  if (enabled.length === 0) throw new NoEnabledAccounts()

  // Quota lookups run in parallel; failures are tolerated per account.
  const withQuota = await Promise.all(
    enabled.map(async (e) => ({ ...e, quota: await getQuotaCached(e.account.apiKey) })),
  )

  // Rotation-order candidates starting after the last used index.
  const order = enabled.map((e) => e.index)
  const start = lastIndex >= 0 ? order.findIndex((i) => i > lastIndex) : 0
  const rotated = start === -1
    ? order
    : [...order.slice(start), ...order.slice(0, start)]

  // Only accounts with a readable quota are candidates. Accounts whose lookup
  // failed still appear in `rotated` (that is the full enabled set, which fixes
  // the rotation order) but are skipped rather than scored as if they had no
  // usage at all.
  const known = withQuota.filter((e) => !e.quota.error)
  if (known.length > 0) {
    // Prefer accounts that can serve the request now; if none can, fall back to
    // the least-full of them rather than to an account with unknown usage.
    const usable = known.filter((e) => isAccountUsable(e.quota))
    const pool = usable.length > 0 ? usable : known

    const windows = discriminatingWindows(pool.map((e) => e.quota))

    let best: { account: GoAccount; index: number; quota?: QuotaInfo; reason: string } | null = null
    let bestRisk = -1
    let bestScore = Number.POSITIVE_INFINITY
    for (const idx of rotated) {
      const e = pool.find((x) => x.index === idx)
      if (!e) continue
      const risk = wasteRisk(e.quota, now, windows)
      const score = scoreAccount(e.quota)
      const better = best === null
        || risk > bestRisk + RISK_EPSILON
        || (Math.abs(risk - bestRisk) <= RISK_EPSILON && score < bestScore)
      if (!better) continue
      bestRisk = risk
      bestScore = score
      best = {
        account: e.account,
        index: e.index,
        quota: e.quota,
        reason: risk > 0
          ? "expiring-quota"
          : isWeeklyExhausted(e.quota) ? "weekly quota exhausted" : "quota-aware",
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
