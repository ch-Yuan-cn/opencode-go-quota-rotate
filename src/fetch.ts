import type { GoAccount } from "./types.ts"
import { log } from "./logger.ts"

export interface RotatingFetchState {
  activeIndex: number | null
  exhausted: Set<number>
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Quota-exhaustion patterns in error bodies. Covers rate limits, usage limits,
 * insufficient balance and 429-style messages that OpenCode Go returns as
 * non-429 status codes (402/403/409/5xx).
 */
export const QUOTA_ERROR_BODY =
  /(rate\s*limit|usage\s*limit|quota|insufficient\s+balance|balance|limit\s+reached|too\s+many\s+requests)/i

export function isQuotaErrorStatus(status: number): boolean {
  return status === 429 || status === 402 || status === 403 || status === 409 || status >= 500
}

/**
 * Request-level rotating fetch with quota-aware failover.
 *
 * 1. Signs every request with the active account key (fully replaces the
 *    Authorization header).
 * 2. Fails over when the response is a 429, or a 402/403/409/5xx whose body
 *    matches QUOTA_ERROR_BODY. The account is marked exhausted and the same
 *    request is retried with the next enabled, non-exhausted account.
 * 3. When every account is exhausted, returns a synthetic 429 Response.
 * 4. Non-error responses are returned untouched (body never consumed).
 */
export function createRotatingFetch(
  accounts: GoAccount[],
  startIndex: number,
  baseFetch?: FetchFn,
): { fetch: FetchFn; state: RotatingFetchState } {
  const state: RotatingFetchState = {
    activeIndex: null,
    exhausted: new Set(),
  }
  const useFetch: FetchFn = baseFetch ?? (globalThis.fetch as FetchFn)

  /** Next enabled, non-exhausted account strictly after `from` (wrapping). */
  function nextCandidate(from: number): { account: GoAccount; index: number } | null {
    const total = accounts.length
    if (total === 0) return null
    for (let i = 1; i <= total; i++) {
      const idx = (from + i) % total
      const acct = accounts[idx]
      if (acct && acct.enabled && !state.exhausted.has(idx)) {
        return { account: acct, index: idx }
      }
    }
    return null
  }

  function pickActive(): { account: GoAccount; index: number } | null {
    if (state.activeIndex !== null) {
      const acct = accounts[state.activeIndex]
      if (acct && acct.enabled && !state.exhausted.has(state.activeIndex)) {
        return { account: acct, index: state.activeIndex }
      }
      return nextCandidate(state.activeIndex)
    }
    // Start from the account the loader picked. -1 means "start from the
    // beginning" (used by tests).
    const acct = accounts[startIndex]
    if (acct && acct.enabled && !state.exhausted.has(startIndex)) {
      return { account: acct, index: startIndex }
    }
    return nextCandidate(startIndex)
  }

  function exhaustedResponse(): Response {
    return new Response("all Go accounts exhausted", {
      status: 429,
      statusText: "All accounts rate-limited",
    })
  }

  const fetch: FetchFn = async (input, init) => {
    let current = pickActive()
    if (!current) return exhaustedResponse()

    for (;;) {
      const headers = new Headers(init?.headers)
      headers.delete("authorization")
      headers.delete("Authorization")
      headers.set("Authorization", "Bearer " + current.account.apiKey)

      const response = await useFetch(input, { ...init, headers })

      if (response.status === 429) {
        // Rate limited — no need to read the body.
        state.exhausted.add(current.index)
      } else if (isQuotaErrorStatus(response.status)) {
        // Only treat as exhausted when the body actually mentions quota/balance.
        const clone = response.clone()
        const body = await clone.text()
        if (!QUOTA_ERROR_BODY.test(body)) {
          return response // not a quota error after all
        }
        state.exhausted.add(current.index)
      } else {
        return response // healthy response, body untouched
      }

      log("warn", "failover", {
        from: current.index,
        key: maskKey(current.account.apiKey),
        status: response.status,
      })

      const next = nextCandidate(current.index)
      if (!next) return exhaustedResponse()
      current = next
    }
  }

  return { fetch, state }
}

function maskKey(key: string): string {
  if (key.length <= 10) return key
  return key.slice(0, 7) + "..." + key.slice(-4)
}