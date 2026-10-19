/**
 * Pi coding agent adapter.
 *
 * Registers an `opencode-pool` provider in Pi that reuses this repository's
 * quota-aware selection ({@link pickAccount}) and the OpenCode Go usage API,
 * then rewrites the credential per request. Quota, rate-limit, and dead-key
 * failures rotate to the next account inside the same request.
 *
 * Why an adapter instead of a second implementation: Pi's built-in
 * `opencode-go` provider resolves one key at startup, and Pi classifies Go
 * usage limits (`GoUsageLimitError`, `Monthly usage limit reached`) as
 * **non-retryable**, so the built-in auto-retry never rotates. The selection
 * rules and the failover classification must stay identical to the OpenCode
 * plugin, so both import from `rotate.ts` and `quota.ts` here.
 *
 * Install (copy, not link — the extension is a single self-contained file):
 *   npm run build:pi
 *   cp dist/pi-extension.js ~/.pi/agent/extensions/opencode-pool.js
 *
 * Then in Pi: `/model` → pick `opencode-pool/...`, and `/pool` shows the pool.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  RISK_EPSILON,
  discriminatingWindows,
  isAccountUsable,
  scoreAccount,
  wasteRisk,
} from "./rotate.ts"
import { queryQuota } from "./quota.ts"
import type { AccountsFile, GoAccount, QuotaInfo } from "./types.ts"

/** Provider id registered in Pi. */
export const PI_PROVIDER_ID = "opencode-pool"
export const PI_PROVIDER_NAME = "OpenCode Go (账号池)"

/** Account file shared with the OpenCode plugin and the DSH plugin. */
export const DEFAULT_ACCOUNTS_FILE = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "opencode-go-accounts.json",
)

/** Required per-conversation routing header on Go endpoints. */
const SESSION_HEADER = "x-opencode-session"

/** Quota lookups are cached this long so a request does not pay for four calls. */
const QUOTA_TTL_MS = 3 * 60 * 1000
/** A quota-exhausted account is skipped this long. Mirrors the OpenCode plugin. */
const COOLDOWN_MS = 10 * 60 * 1000
/** A dead credential is skipped longer: it needs a human, not a reset. */
const AUTH_COOLDOWN_MS = 60 * 60 * 1000

interface QuotaCacheEntry {
  at: number
  quota: QuotaInfo
}

const quotaCache = new Map<string, QuotaCacheEntry>()
const cooldownUntil = new Map<string, number>()
const cooldownKind = new Map<string, "quota" | "auth">()

// ---------------------------------------------------------------------------
// Account loading and quota
// ---------------------------------------------------------------------------

/**
 * Read the accounts file. Returns an empty pool for a missing or malformed
 * file rather than throwing: Pi loads extensions during startup, and a broken
 * file must not stop the agent from booting with other providers.
 */
export function loadPiAccounts(file: string = DEFAULT_ACCOUNTS_FILE): GoAccount[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  let parsed: AccountsFile
  try {
    parsed = JSON.parse(raw) as AccountsFile
  } catch {
    return []
  }
  if (!Array.isArray(parsed?.accounts)) return []
  return parsed.accounts.filter(
    (a): a is GoAccount =>
      Boolean(a) &&
      typeof a === "object" &&
      typeof a.apiKey === "string" &&
      a.apiKey.length > 0 &&
      a.enabled !== false,
  )
}

/**
 * The quota lookup used by selection. Swappable so tests never hit the network
 * (`test/README.md`: "Tests must not touch real files" — same rule for HTTP).
 */
let quotaLookup: (apiKey: string) => Promise<QuotaInfo> = queryQuota

/** Replace the quota lookup. Tests only; returns the previous one. */
export function setQuotaLookup(next: (apiKey: string) => Promise<QuotaInfo>): (apiKey: string) => Promise<QuotaInfo> {
  const previous = quotaLookup
  quotaLookup = next
  return previous
}

async function cachedQuota(apiKey: string): Promise<QuotaInfo> {
  const hit = quotaCache.get(apiKey)
  if (hit && Date.now() - hit.at < QUOTA_TTL_MS) return hit.quota
  const quota = await quotaLookup(apiKey)
  quotaCache.set(apiKey, { at: Date.now(), quota })
  return quota
}

/**
 * Rank accounts for one request, reusing {@link pickAccount} so scoring,
 * rotation order, and the "usable first" rule stay identical to OpenCode.
 * Cooling accounts are filtered out before selection; when every account is
 * cooling, the least-cooled one is used so the user is never fully locked out.
 */
export async function rankForRequest(
  accounts: GoAccount[],
  lastIndex: number,
  now: number = Date.now(),
): Promise<{ account: GoAccount; index: number; quota?: QuotaInfo; reason: string }[]> {
  const nowMs = now
  const ready: GoAccount[] = []
  const cooling: GoAccount[] = []
  for (const account of accounts) {
    const until = cooldownUntil.get(account.apiKey) ?? 0
    if (until > nowMs) cooling.push(account)
    else ready.push(account)
  }

  const ordered: { account: GoAccount; index: number; quota?: QuotaInfo; reason: string }[] = []

  if (ready.length > 0) {
    // Quota for every account in one batch, then rank with the same rules the
    // OpenCode plugin uses. `pickAccount` is not called directly because it
    // fetches quota itself, which would bypass the injectable lookup.
    const withQuota = await Promise.all(
      ready.map(async (account, index) => ({ account, index, quota: await cachedQuota(account.apiKey) })),
    )

    const usable = withQuota.filter((e) => !e.quota.error && isAccountUsable(e.quota))
    const pool = usable.length > 0 ? usable : withQuota

    // Preference order: repeatedly take the best remaining candidate.
    let remaining = pool.slice()
    while (remaining.length > 0) {
      const windows = discriminatingWindows(remaining.map((e) => e.quota))
      let bestIndex = 0
      let bestRisk = Number.NEGATIVE_INFINITY
      let bestScore = Number.POSITIVE_INFINITY
      for (let i = 0; i < remaining.length; i++) {
        const risk = wasteRisk(remaining[i].quota, nowMs, windows)
        const score = scoreAccount(remaining[i].quota)
        const better =
          risk > bestRisk + RISK_EPSILON ||
          (Math.abs(risk - bestRisk) <= RISK_EPSILON && score < bestScore)
        if (better) {
          bestRisk = risk
          bestScore = score
          bestIndex = i
        }
      }
      const chosen = remaining[bestIndex]
      ordered.push({
        account: chosen.account,
        index: chosen.index,
        quota: chosen.quota,
        reason: bestRisk > 0 ? "expiring-quota" : "quota-aware",
      })
      remaining = remaining.filter((_, i) => i !== bestIndex)
    }
  }

  for (const account of cooling) {
    ordered.push({ account, index: 0, reason: "cooling down" })
  }
  return ordered
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Text that means "this account cannot serve the request right now". */
const QUOTA_PATTERNS = [
  /go\s*usage\s*limit/i,
  /free\s*usage\s*limit/i,
  /(?:rolling|weekly|monthly)\s+usage\s+limit/i,
  /usage\s*limit\s*reached/i,
  /insufficient_quota/i,
  /quota\s+exceeded/i,
  /exceeded\s+your\s+(?:current\s+)?quota/i,
  /out\s+of\s+budget/i,
  /available\s+balance/i,
  /insufficient\s+(?:balance|funds|credits)/i,
  /\b429\b/,
  /too\s+many\s+requests/i,
  /rate[_\s-]?limit/i,
]

/** Text that means "this credential is dead" — rotate, but cool down longer. */
const AUTH_PATTERNS = [
  /invalid\s+credential/i,
  /invalid\s+(?:api\s*key|token)/i,
  /unauthorized/i,
  /\b401\b/,
  /api\s*key\s+(?:is\s+)?(?:invalid|expired|revoked)/i,
]

/**
 * Classify a provider error message. Returns the cooldown kind, or `undefined`
 * when rotating would not help (region restrictions, context overflow, 5xx
 * without quota wording, user aborts).
 */
export function classifyFailure(message: string | undefined): "quota" | "auth" | undefined {
  if (!message) return undefined
  if (AUTH_PATTERNS.some((re) => re.test(message))) return "auth"
  if (QUOTA_PATTERNS.some((re) => re.test(message))) return "quota"
  return undefined
}

/** Mark an account unusable for the cooldown that matches the failure. */
export function coolDown(apiKey: string, kind: "quota" | "auth", now: number = Date.now()): void {
  const ms = kind === "auth" ? AUTH_COOLDOWN_MS : COOLDOWN_MS
  cooldownUntil.set(apiKey, now + ms)
  cooldownKind.set(apiKey, kind)
}

/** Clear every cooldown and cached quota. Exposed for tests and `/pool reset`. */
export function resetPoolState(): void {
  quotaCache.clear()
  cooldownUntil.clear()
  cooldownKind.clear()
}

/** Read-only snapshot for `/pool`. */
export async function describePool(
  accounts: GoAccount[],
  now: number = Date.now(),
): Promise<{ label: string; detail: string; cooling: boolean; preferred: boolean }[]> {
  const ranked = await rankForRequest(accounts, -1, now)
  return Promise.all(
    ranked.map(async (entry, index) => {
      const quota = await cachedQuota(entry.account.apiKey)
      const until = cooldownUntil.get(entry.account.apiKey) ?? 0
      const cooling = until > now
      const detail = quota.error
        ? `查询失败：${quota.error}`
        : `滚动 ${quota.rolling?.percent ?? "?"}% / 周 ${quota.weekly?.percent ?? "?"}% / 月 ${quota.monthly?.percent ?? "?"}%`
      const cool = cooling
        ? ` · 冷却 ${Math.ceil((until - now) / 60000)} 分钟（${cooldownKind.get(entry.account.apiKey) === "auth" ? "凭证" : "额度"}）`
        : ""
      return {
        label: entry.account.label || `账号 ${entry.index + 1}`,
        detail: detail + cool,
        cooling,
        preferred: index === 0 && !cooling,
      }
    }),
  )
}

export { isAccountUsable }
