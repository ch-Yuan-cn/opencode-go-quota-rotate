import type { QuotaInfo, QuotaWindow } from "./types.ts"

/**
 * OpenCode Go usage API. Verified live:
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <api-key>
 *   -> { usage: { rolling: {status, percent, resetsAt},
 *                 weekly:  {status, percent, resetsAt},
 *                 monthly: {status, percent, resetsAt} } }
 * percent = used percentage (0-100); status = "ok" | "rate-limited".
 */
export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

/** Normalize an unknown window value; returns undefined for malformed input. */
export function normalizeWindow(value: unknown): QuotaWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  const percent = typeof v.percent === "number" ? v.percent : Number(v.percent)
  if (!Number.isFinite(percent)) return undefined
  return {
    status: typeof v.status === "string" ? v.status : "ok",
    percent,
    resetsAt: typeof v.resetsAt === "string" ? v.resetsAt : "",
  }
}

/**
 * Query live usage for one API key. Non-2xx responses are mapped to
 * { error: "HTTP <status>" }; network/timeout failures to { error: "..." }.
 * Never throws.
 */
export async function queryQuota(apiKey: string, timeoutMs = 8000): Promise<QuotaInfo> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(OPENCODE_GO_USAGE_URL, {
      headers: {
        Authorization: "Bearer " + apiKey,
        Accept: "application/json",
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      return { error: "HTTP " + res.status, fetchedAt: Date.now() }
    }
    const json: unknown = await res.json()
    const usage = (json as { usage?: Record<string, unknown> })?.usage
    if (typeof usage !== "object" || usage === null) {
      return { error: "malformed response", fetchedAt: Date.now() }
    }
    return {
      rolling: normalizeWindow(usage.rolling),
      weekly: normalizeWindow(usage.weekly),
      monthly: normalizeWindow(usage.monthly),
      fetchedAt: Date.now(),
    }
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError"
      ? "timeout"
      : err instanceof Error ? err.message : String(err)
    return { error: reason, fetchedAt: Date.now() }
  } finally {
    clearTimeout(timer)
  }
}