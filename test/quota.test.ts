import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeWindow, queryQuota, OPENCODE_GO_USAGE_URL } from "../src/quota.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("normalizeWindow parses a valid window", () => {
  const w = normalizeWindow({ status: "ok", percent: 14, resetsAt: "2026-08-26T11:10:18.818Z" })
  assert.deepEqual(w, { status: "ok", percent: 14, resetsAt: "2026-08-26T11:10:18.818Z" })
})

test("normalizeWindow rejects malformed input", () => {
  assert.equal(normalizeWindow(null), undefined)
  assert.equal(normalizeWindow("x"), undefined)
  assert.equal(normalizeWindow({ percent: "not-a-number" }), undefined)
})

test("normalizeWindow coerces numeric string percentages", () => {
  const w = normalizeWindow({ status: "ok", percent: "5" })
  assert.equal(w?.percent, 5)
  assert.equal(w?.status, "ok")
})

test("queryQuota sends Bearer auth and parses the usage payload", async () => {
  const original = globalThis.fetch
  let captured: { url: string; auth: string | undefined } | undefined
  globalThis.fetch = (async (url: any, init: any) => {
    const headers = new Headers(init?.headers)
    captured = { url: String(url), auth: headers.get("authorization") ?? undefined }
    return jsonResponse({
      usage: {
        rolling: { status: "ok", percent: 14, resetsAt: "r" },
        weekly: { status: "ok", percent: 1, resetsAt: "w" },
        monthly: { status: "ok", percent: 0, resetsAt: "m" },
      },
    })
  }) as any
  try {
    const q = await queryQuota("sk-test-1")
    assert.equal(captured?.url, OPENCODE_GO_USAGE_URL)
    assert.equal(captured?.auth, "Bearer sk-test-1")
    assert.equal(q.error, undefined)
    assert.equal(q.weekly?.percent, 1)
    assert.equal(q.rolling?.percent, 14)
    assert.equal(q.monthly?.percent, 0)
  } finally {
    globalThis.fetch = original
  }
})

test("queryQuota maps non-2xx to error", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response("nope", { status: 401 })) as any
  try {
    const q = await queryQuota("sk-test-2")
    assert.equal(q.error, "HTTP 401")
    assert.equal(q.weekly, undefined)
  } finally {
    globalThis.fetch = original
  }
})

test("queryQuota catches network errors", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => { throw new TypeError("fetch failed") }) as any
  try {
    const q = await queryQuota("sk-test-3")
    assert.equal(q.error, "fetch failed")
  } finally {
    globalThis.fetch = original
  }
})
