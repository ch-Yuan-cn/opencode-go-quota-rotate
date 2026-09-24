import { test } from "node:test"
import assert from "node:assert/strict"
import { scoreAccount, isWeeklyExhausted, pickAccount, NoEnabledAccounts } from "../src/rotate.ts"
import type { GoAccount } from "../src/types.ts"

function account(key: string): GoAccount {
  return { apiKey: key, addedAt: 0, enabled: true }
}

/**
 * Stub global fetch to serve canned quota responses keyed by API key.
 * Returns a restore function.
 */
function stubQuota(
  perKey: Record<string, { weekly: number; weeklyStatus?: string; rolling?: number; fail?: boolean }>,
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers)
    const auth = headers.get("authorization") ?? ""
    const key = auth.replace(/^Bearer /, "")
    const spec = perKey[key]
    if (!spec) return new Response("not found", { status: 404 })
    if (spec.fail) return new Response("boom", { status: 500 })
    return new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: spec.rolling ?? 0, resetsAt: "" },
        weekly: { status: spec.weeklyStatus ?? "ok", percent: spec.weekly, resetsAt: "" },
        monthly: { status: "ok", percent: 0, resetsAt: "" },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
  return () => { globalThis.fetch = original }
}

test("scoreAccount: normal accounts score weekly*10 + rolling", () => {
  const q = { fetchedAt: 0, weekly: { status: "ok", percent: 1, resetsAt: "" }, rolling: { status: "ok", percent: 2, resetsAt: "" } } as any
  assert.equal(scoreAccount(q), 12)
})

test("scoreAccount: weekly rate-limited is heavily penalized", () => {
  const q = { fetchedAt: 0, weekly: { status: "rate-limited", percent: 100, resetsAt: "" }, rolling: { status: "ok", percent: 14, resetsAt: "" } } as any
  assert.equal(scoreAccount(q), 1014)
})

test("scoreAccount: weekly >= 100 counts as exhausted even when status is ok", () => {
  const q = { fetchedAt: 0, weekly: { status: "ok", percent: 100, resetsAt: "" }, rolling: { status: "ok", percent: 0, resetsAt: "" } } as any
  assert.equal(scoreAccount(q), 1000)
})

test("scoreAccount: missing quota scores infinity", () => {
  assert.equal(scoreAccount(undefined), Number.POSITIVE_INFINITY)
})

test("isWeeklyExhausted detects rate-limited and full windows", () => {
  assert.equal(isWeeklyExhausted({ weekly: { status: "rate-limited", percent: 100, resetsAt: "" } } as any), true)
  assert.equal(isWeeklyExhausted({ weekly: { status: "ok", percent: 100, resetsAt: "" } } as any), true)
  assert.equal(isWeeklyExhausted({ weekly: { status: "ok", percent: 99, resetsAt: "" } } as any), false)
  assert.equal(isWeeklyExhausted(undefined), false)
})

test("pickAccount chooses the lowest score", async () => {
  // A: weekly 1 (score 10), B: weekly 5 (score 50) -> pick A
  const restore = stubQuota({ "sk-pick-a": { weekly: 1 }, "sk-pick-b": { weekly: 5 } })
  try {
    const r = await pickAccount([account("sk-pick-a"), account("sk-pick-b")], -1)
    assert.equal(r.index, 0)
    assert.equal(r.reason, "quota-aware")
  } finally {
    restore()
  }
})

test("pickAccount avoids weekly-exhausted accounts", async () => {
  // A: weekly exhausted (score 1000+), B: weekly 1 (score 10) -> pick B
  const restore = stubQuota({ "sk-ex-a": { weekly: 100, weeklyStatus: "rate-limited" }, "sk-ex-b": { weekly: 1 } })
  try {
    const r = await pickAccount([account("sk-ex-a"), account("sk-ex-b")], -1)
    assert.equal(r.index, 1)
    assert.equal(r.reason, "quota-aware")
  } finally {
    restore()
  }
})

test("pickAccount breaks score ties in rotation order", async () => {
  // Both score 10; last used 0 -> prefer index 1
  const restore = stubQuota({ "sk-tie-a": { weekly: 1 }, "sk-tie-b": { weekly: 1 } })
  try {
    const r = await pickAccount([account("sk-tie-a"), account("sk-tie-b")], 0)
    assert.equal(r.index, 1)
  } finally {
    restore()
  }
})

test("pickAccount falls back to round-robin when quota API is down", async () => {
  const restore = stubQuota({ "sk-rr-a": { weekly: 0, fail: true }, "sk-rr-b": { weekly: 0, fail: true } })
  try {
    const r = await pickAccount([account("sk-rr-a"), account("sk-rr-b")], 0)
    assert.equal(r.index, 1)
    assert.match(r.reason, /round-robin/)
  } finally {
    restore()
  }
})

test("pickAccount skips disabled accounts", async () => {
  const restore = stubQuota({ "sk-dis-b": { weekly: 1 } })
  try {
    const disabled = { apiKey: "sk-dis-a", addedAt: 0, enabled: false }
    const r = await pickAccount([disabled, account("sk-dis-b")], -1)
    assert.equal(r.index, 1)
  } finally {
    restore()
  }
})

test("pickAccount throws NoEnabledAccounts when nothing is enabled", async () => {
  await assert.rejects(
    pickAccount([{ apiKey: "x", addedAt: 0, enabled: false }], -1),
    NoEnabledAccounts,
  )
})

// --- 回归：额度查询失败 ≠ 满分 -------------------------------------------------
// 实测踩过：被吊销的 key 在 /usage 上返回 401，查询失败的对象是真值，
// 旧实现把缺失窗口读成 0 → 得分 0（全场最优）→ 死 key 永远被选中。

test("scoreAccount: errored quota lookup is unknown, not a perfect score", () => {
  assert.equal(scoreAccount({ error: "HTTP 401", fetchedAt: 0 } as any), Number.POSITIVE_INFINITY)
})

test("pickAccount: never prefers an account whose quota lookup failed", async () => {
  // A 的额度查询失败（旧实现得分 0，会赢），B 是正常的 weekly 1（得分 10）。
  const restore = stubQuota({ "sk-err-a": { weekly: 0, fail: true }, "sk-err-b": { weekly: 1 } })
  try {
    const r = await pickAccount([account("sk-err-a"), account("sk-err-b")], -1)
    assert.equal(r.index, 1, "must pick the account with a readable quota")
    assert.equal(r.reason, "quota-aware")
  } finally {
    restore()
  }
})

test("pickAccount: a fresh empty account beats an unreadable one", async () => {
  // 现实场景：账号1 被吊销（查询失败），账号3 全新（monthly 0%、rolling 1 → 得分 1）。
  // 旧实现选账号1（得分 0）；新实现必须选账号3。
  const restore = stubQuota({ "sk-dead-a": { weekly: 0, fail: true }, "sk-fresh-c": { weekly: 0, rolling: 1 } })
  try {
    const r = await pickAccount([account("sk-dead-a"), account("sk-fresh-c")], 0)
    assert.equal(r.index, 1, "a brand-new account must win over a revoked key")
  } finally {
    restore()
  }
})

test("pickAccount: round-robin still applies when every lookup fails", async () => {
  const restore = stubQuota({ "sk-all-a": { weekly: 0, fail: true }, "sk-all-b": { weekly: 0, fail: true } })
  try {
    const r = await pickAccount([account("sk-all-a"), account("sk-all-b")], 0)
    assert.equal(r.index, 1)
    assert.match(r.reason, /round-robin/)
  } finally {
    restore()
  }
})
