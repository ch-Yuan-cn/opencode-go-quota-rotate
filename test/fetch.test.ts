import { test } from "node:test"
import assert from "node:assert/strict"
import { createRotatingFetch } from "../src/fetch.ts"
import type { GoAccount } from "../src/types.ts"

function account(key: string): GoAccount {
  return { apiKey: key, addedAt: 0, enabled: true }
}

const TWO = [account("sk-f-one"), account("sk-f-two")]

function resp(status: number, body: string): Response {
  return new Response(body, { status })
}

/** Base fetch mock that records (authorization header, input) per call. */
function mockBase(...responses: Response[]) {
  const calls: { auth: string | null; url: string }[] = []
  const fn = (async (input: any, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ auth: headers.get("authorization"), url: String(input) })
    const r = responses.shift()
    if (!r) throw new Error("mock exhausted")
    return r
  }) as any
  return { fn, calls }
}

test("healthy response passes through with first account auth", async () => {
  const { fn, calls } = mockBase(resp(200, "ok"))
  const { fetch } = createRotatingFetch(TWO, -1, fn)
  const res = await fetch("https://api.example.com/v1/chat")
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "ok")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].auth, "Bearer sk-f-one")
})

test("429 fails over to the next account and returns its response", async () => {
  const { fn, calls } = mockBase(resp(429, "rate limited"), resp(200, "from two"))
  const { fetch } = createRotatingFetch(TWO, -1, fn)
  const res = await fetch("https://api.example.com/v1/chat")
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "from two")
  assert.equal(calls.length, 2)
  assert.equal(calls[0].auth, "Bearer sk-f-one")
  assert.equal(calls[1].auth, "Bearer sk-f-two")
})

test("all accounts exhausted returns synthetic 429", async () => {
  const { fn, calls } = mockBase(resp(429, "a"), resp(429, "b"))
  const { fetch } = createRotatingFetch(TWO, -1, fn)
  const res = await fetch("https://api.example.com/v1/chat")
  assert.equal(res.status, 429)
  assert.equal(calls.length, 2)
  assert.match(await res.text(), /exhausted/)
})

test("402 with insufficient-balance body triggers failover", async () => {
  const { fn, calls } = mockBase(resp(402, "Insufficient balance in workspace"), resp(200, "ok"))
  const { fetch } = createRotatingFetch(TWO, -1, fn)
  const res = await fetch("https://api.example.com/v1/chat")
  assert.equal(res.status, 200)
  assert.equal(calls.length, 2)
})

test("500 with rate-limit body triggers failover", async () => {
  const { fn } = mockBase(resp(500, "rate limit exceeded"), resp(200, "ok"))
  const { fetch } = createRotatingFetch(TWO, -1, fn)
  const res = await fetch("https://api.example.com/v1/chat")
  assert.equal(res.status, 200)
})

test("403 without quota keywords is returned as-is (no failover)", async () => {
  const { fn, calls } = mockBase(resp(403, "Forbidden: invalid scope"))
  const { fetch } = createRotatingFetch(TWO, -1, fn)
  const res = await fetch("https://api.example.com/v1/chat")
  assert.equal(res.status, 403)
  assert.equal(await res.text(), "Forbidden: invalid scope")
  assert.equal(calls.length, 1)
})

test("500 without quota keywords is returned as-is", async () => {
  const { fn, calls } = mockBase(resp(500, "Internal Server Error"))
  const { fetch } = createRotatingFetch(TWO, -1, fn)
  const res = await fetch("https://api.example.com/v1/chat")
  assert.equal(res.status, 500)
  assert.equal(calls.length, 1)
})

test("disabled accounts are skipped during failover", async () => {
  const accounts = [account("sk-f-a"), { apiKey: "sk-f-dis", addedAt: 0, enabled: false }, account("sk-f-c")]
  const { fn, calls } = mockBase(resp(429, "a"), resp(200, "c"))
  const { fetch } = createRotatingFetch(accounts, -1, fn)
  const res = await fetch("https://api.example.com/v1/chat")
  assert.equal(res.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].auth, "Bearer sk-f-c")
})

test("no accounts returns synthetic 429 immediately", async () => {
  const { fn } = mockBase()
  const { fetch } = createRotatingFetch([], -1, fn)
  const res = await fetch("https://api.example.com/v1/chat")
  assert.equal(res.status, 429)
})

test("failover persists across requests (exhausted account stays exhausted)", async () => {
  // First request exhausts account 1; second request must start on account 2.
  const { fn, calls } = mockBase(resp(429, "a"), resp(200, "from two"), resp(429, "b"))
  const { fetch } = createRotatingFetch(TWO, -1, fn)
  const r1 = await fetch("https://api.example.com/v1/chat")
  assert.equal(r1.status, 200)
  // Now only account 2 remains; it responds 429 -> everything exhausted
  const r2 = await fetch("https://api.example.com/v1/chat")
  assert.equal(r2.status, 429)
  assert.equal(calls.length, 3)
  assert.equal(calls[2].auth, "Bearer sk-f-two")
})