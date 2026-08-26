import type { QuotaInfo } from "./types"

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

// TODO(impl): queryQuota(apiKey, timeoutMs?) -> Promise<QuotaInfo>
// Use AbortController for the timeout; map non-2xx to { error: "HTTP <status>" }.
export async function queryQuota(apiKey: string, timeoutMs = 8000): Promise<QuotaInfo> {
  void apiKey
  void timeoutMs
  throw new Error("not implemented")
}
