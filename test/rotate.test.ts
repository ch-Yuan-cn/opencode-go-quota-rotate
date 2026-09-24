import { test } from "node:test"
import assert from "node:assert/strict"
import { scoreAccount, isWeeklyExhausted, isAccountUsable, wasteRisk, discriminatingWindows, pickAccount, NoEnabledAccounts } from "../src/rotate.ts"
import type { GoAccount } from "../src/types.ts"

function account(key: string): GoAccount {
  return { apiKey: key, addedAt: 0, enabled: true }
}

/**
 * Stub global fetch to serve canned quota responses keyed by API key.
 * Returns a restore function.
 */
interface QuotaSpec {
  weekly: number
  weeklyStatus?: string
  weeklyResetsAt?: string
  rolling?: number
  rollingStatus?: string
  monthly?: number
  monthlyResetsAt?: string
  fail?: boolean
}

function stubQuota(perKey: Record<string, QuotaSpec>): () => void {
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
        rolling: { status: spec.rollingStatus ?? "ok", percent: spec.rolling ?? 0, resetsAt: "" },
        weekly: { status: spec.weeklyStatus ?? "ok", percent: spec.weekly, resetsAt: spec.weeklyResetsAt ?? "" },
        monthly: { status: "ok", percent: spec.monthly ?? 0, resetsAt: spec.monthlyResetsAt ?? "" },
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
  assert.equal(scoreAccount(q), 3014)
})

test("scoreAccount: weekly >= 100 counts as exhausted even when status is ok", () => {
  const q = { fetchedAt: 0, weekly: { status: "ok", percent: 100, resetsAt: "" }, rolling: { status: "ok", percent: 0, resetsAt: "" } } as any
  assert.equal(scoreAccount(q), 3000)
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

// --- 新功能：把「刷新时间」纳入选号 ---------------------------------------------
// 额度只有在重置前用掉才算数，所以剩余额度越接近重置、越该先用它。

const H = 3_600_000
const NOW = Date.parse("2026-09-24T03:00:00.000Z")
const iso = (hoursFromNow: number) => new Date(NOW + hoursFromNow * H).toISOString()

test("wasteRisk: 剩余额度 / 距重置小时数", () => {
  // 周剩 10%（已用 90），10 小时后重置 -> 1.0/小时
  assert.equal(wasteRisk({ fetchedAt: 0, weekly: { status: "ok", percent: 90, resetsAt: iso(10) } } as any, NOW), 1)
})

test("wasteRisk: 取周/月里最大的那个", () => {
  const q = {
    fetchedAt: 0,
    weekly: { status: "ok", percent: 99, resetsAt: iso(100) },   // 1/100 = 0.01
    monthly: { status: "ok", percent: 50, resetsAt: iso(10) },   // 50/10 = 5
  } as any
  assert.equal(wasteRisk(q, NOW), 5)
})

test("wasteRisk: 滚动窗口不参与（它是限速，不是会被浪费的预算）", () => {
  const q = { fetchedAt: 0, rolling: { status: "ok", percent: 0, resetsAt: iso(0.1) } } as any
  assert.equal(wasteRisk(q, NOW), 0)
})

test("wasteRisk: 查询失败 / 没有 resetsAt / 窗口用满 都算 0", () => {
  assert.equal(wasteRisk({ error: "HTTP 401", fetchedAt: 0 } as any, NOW), 0)
  assert.equal(wasteRisk({ fetchedAt: 0, weekly: { status: "ok", percent: 50, resetsAt: "" } } as any, NOW), 0)
  assert.equal(wasteRisk({ fetchedAt: 0, weekly: { status: "rate-limited", percent: 100, resetsAt: iso(1) } } as any, NOW), 0)
  assert.equal(wasteRisk(undefined, NOW), 0)
})

test("wasteRisk: 重置近在眼前时按 15 分钟下限算，不会除出无穷大", () => {
  const q = { fetchedAt: 0, monthly: { status: "ok", percent: 0, resetsAt: iso(0.001) } } as any
  assert.equal(wasteRisk(q, NOW), 400)   // 100 / 0.25
})

test("pickAccount: 优先用「剩余额度快重置」的账号", async () => {
  // A: 月已用 20%，2 天后重置 -> 风险 80/48 ≈ 1.67（周额度 30 天后才重置，不构成风险）
  // B: 月 0%，30 天后重置 -> 风险 100/720 ≈ 0.14
  // 只看额度占比的话 B 更空；加上刷新时间后应该先用 A。
  const restore = stubQuota({
    "sk-exp-a": { weekly: 20, weeklyResetsAt: iso(720), monthly: 20, monthlyResetsAt: iso(48) },
    "sk-exp-b": { weekly: 0, weeklyResetsAt: iso(720), monthly: 0, monthlyResetsAt: iso(720) },
  })
  try {
    const r = await pickAccount([account("sk-exp-a"), account("sk-exp-b")], -1, NOW)
    assert.equal(r.index, 0, "应先用即将重置额度的账号")
    assert.equal(r.reason, "expiring-quota")
  } finally {
    restore()
  }
})

test("pickAccount: 没有 resetsAt 时退回原来的「用得最少」口径", async () => {
  const restore = stubQuota({
    "sk-noreset-a": { weekly: 20, monthly: 20 },
    "sk-noreset-b": { weekly: 0, monthly: 0 },
  })
  try {
    const r = await pickAccount([account("sk-noreset-a"), account("sk-noreset-b")], -1, NOW)
    assert.equal(r.index, 1, "没有刷新时间信息时按额度占比选")
    assert.equal(r.reason, "quota-aware")
  } finally {
    restore()
  }
})

test("pickAccount: 滚动窗口用满的账号即便额度最该先用也不选（现在用不了）", async () => {
  const restore = stubQuota({
    "sk-rollfull-a": { weekly: 0, rolling: 100, rollingStatus: "rate-limited", monthly: 20, monthlyResetsAt: iso(1) },
    "sk-rollfull-b": { weekly: 0, monthly: 0, monthlyResetsAt: iso(720) },
  })
  try {
    const r = await pickAccount([account("sk-rollfull-a"), account("sk-rollfull-b")], -1, NOW)
    assert.equal(r.index, 1)
  } finally {
    restore()
  }
})

test("isAccountUsable: 任一窗口用满即不可用；查询失败也算不可用", () => {
  assert.equal(isAccountUsable({ fetchedAt: 0, weekly: { status: "ok", percent: 1, resetsAt: "" } } as any), true)
  assert.equal(isAccountUsable({ fetchedAt: 0, rolling: { status: "rate-limited", percent: 100, resetsAt: "" } } as any), false)
  assert.equal(isAccountUsable({ fetchedAt: 0, monthly: { status: "ok", percent: 100, resetsAt: "" } } as any), false)
  assert.equal(isAccountUsable({ error: "HTTP 401", fetchedAt: 0 } as any), false)
})

test("scoreAccount: 三种「用满」的罚分都高于任何健康分数（上限 99*10+99 = 1089）", () => {
  const healthiestButStillHealthy = scoreAccount({
    fetchedAt: 0,
    weekly: { status: "ok", percent: 99, resetsAt: "" },
    rolling: { status: "ok", percent: 99, resetsAt: "" },
  } as any)
  assert.equal(healthiestButStillHealthy, 1089)
  const full = (window: string) => scoreAccount({ fetchedAt: 0, [window]: { status: "ok", percent: 100, resetsAt: "" } } as any)
  assert.ok(full("rolling") > healthiestButStillHealthy)
  assert.ok(full("weekly") > full("rolling"), "周额度恢复更慢，罚分应更重")
  assert.ok(full("monthly") > full("weekly"), "月额度恢复最慢，罚分应最重")
})

test("discriminatingWindows: 只保留各账号重置时间不同的窗口", () => {
  const sharedWeekly = [
    { fetchedAt: 0, weekly: { status: "ok", percent: 1, resetsAt: iso(93) }, monthly: { status: "ok", percent: 90, resetsAt: iso(27) } },
    { fetchedAt: 0, weekly: { status: "ok", percent: 1, resetsAt: iso(93) }, monthly: { status: "ok", percent: 0, resetsAt: iso(703) } },
  ] as any
  assert.deepEqual(discriminatingWindows(sharedWeekly), ["monthly"], "周额度是共同边界，不该参与")
  assert.deepEqual(discriminatingWindows([sharedWeekly[0], sharedWeekly[0]]), [], "全都一样时没有可区分的信息")
  assert.deepEqual(discriminatingWindows([sharedWeekly[0]]), [], "只有一个候选时无需区分")
})

test("pickAccount: 共同的重置边界不驱动选择，退回额度占比", async () => {
  // 周额度对两个账号同时重置（iso(10)），月额度信息相同 -> 没有差异化浪费
  // A 周已用 20%（更满）应让位给 B，而不是因为「A 的额度也在 10h 后重置」而选 A。
  const restore = stubQuota({
    "sk-shared-a": { weekly: 20, weeklyResetsAt: iso(10), monthly: 0, monthlyResetsAt: iso(700) },
    "sk-shared-b": { weekly: 0, weeklyResetsAt: iso(10), monthly: 0, monthlyResetsAt: iso(700) },
  })
  try {
    const r = await pickAccount([account("sk-shared-a"), account("sk-shared-b")], -1, NOW)
    assert.equal(r.index, 1)
    assert.equal(r.reason, "quota-aware")
  } finally {
    restore()
  }
})

test("pickAccount: 重置时间一旦不同，同样的数据就会翻转结果", async () => {
  // 与上一个用例唯一的差别：A 的周额度 10h 后重置、B 的 100h 后 -> A 的风险 80/10 = 8 > B 的 1
  const restore = stubQuota({
    "sk-diff-a": { weekly: 20, weeklyResetsAt: iso(10), monthly: 0, monthlyResetsAt: iso(700) },
    "sk-diff-b": { weekly: 0, weeklyResetsAt: iso(100), monthly: 0, monthlyResetsAt: iso(700) },
  })
  try {
    const r = await pickAccount([account("sk-diff-a"), account("sk-diff-b")], -1, NOW)
    assert.equal(r.index, 0, "A 的剩余额度更快作废，应先用 A")
    assert.equal(r.reason, "expiring-quota")
  } finally {
    restore()
  }
})

test("pickAccount: 实盘形态——周额度共同边界 + 月额度各异，由月额度决定", async () => {
  // 实测 2026-09-24：账号2 月剩 7%（27.4h 后重置）、账号3 月剩 100%（703h）；
  // 两者周额度同一时刻（92.9h）重置。旧口径选账号3（分数 14 < 126），
  // 新口径应先用账号2——它那 7% 明天就作废了。
  const restore = stubQuota({
    "sk-live-2": { weekly: 11, weeklyResetsAt: iso(92.9), monthly: 93, monthlyResetsAt: iso(27.4) },
    "sk-live-3": { weekly: 1, weeklyResetsAt: iso(92.9), monthly: 0, monthlyResetsAt: iso(703.4) },
  })
  try {
    const r = await pickAccount([account("sk-live-2"), account("sk-live-3")], 1, NOW)
    assert.equal(r.index, 0, "应先烧掉即将作废的月额度")
    assert.equal(r.reason, "expiring-quota")
  } finally {
    restore()
  }
})
