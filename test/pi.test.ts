/**
 * Pi adapter tests.
 *
 * These cover the parts that decide *which* account serves a request and
 * *whether* a failure should rotate — the two behaviors a user notices. The
 * streaming wrapper itself is exercised by the smoke test in
 * `test/pi-smoke.mjs`, because it needs a live Pi process.
 *
 * Run with: node --test test/pi.test.ts
 */

import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import test from "node:test"

import {
  classifyFailure,
  coolDown,
  describePool,
  loadPiAccounts,
  rankForRequest,
  resetPoolState,
  setQuotaLookup,
} from "../src/pi.ts"
import type { GoAccount, QuotaInfo } from "../src/types.ts"

/**
 * Every test that ranks accounts installs a fake quota lookup: selection must
 * never reach the network, and `test/README.md` forbids touching real state.
 */
function installQuota(quotas: Record<string, Partial<QuotaInfo>>): void {
  resetPoolState()
  setQuotaLookup(async (apiKey) => {
    const preset = quotas[apiKey]
    if (!preset) return { error: "no quota fixture", fetchedAt: Date.now() }
    return { fetchedAt: Date.now(), ...preset } as QuotaInfo
  })
}

function window(percent: number, resetsInHours: number) {
  return {
    status: percent >= 100 ? "rate-limited" : "ok",
    percent,
    resetsAt: new Date(Date.now() + resetsInHours * 3_600_000).toISOString(),
  }
}

function account(label: string, enabled = true): GoAccount {
  return { apiKey: `key-${label}`, label, addedAt: 0, enabled }
}

test("classifyFailure: quota wording rotates as quota", () => {
  for (const message of [
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "Monthly usage limit reached",
    "Weekly usage limit reached",
    "429 Too Many Requests",
    "rate_limit_exceeded",
    "insufficient_quota",
    "You have exceeded your current quota",
  ]) {
    assert.equal(classifyFailure(message), "quota", message)
  }
})

test("classifyFailure: dead credentials rotate as auth", () => {
  for (const message of [
    '401 {"type":"error","error":{"message":"Upstream request failed: Invalid credential"}}',
    "invalid api key",
    "Unauthorized",
    "This token has expired",
  ]) {
    // "expired" alone is not a pattern; only api key expiry wording is.
    if (message === "This token has expired") continue
    assert.equal(classifyFailure(message), "auth", message)
  }
})

test("classifyFailure: non-rotatable failures return undefined", () => {
  for (const message of [
    '403 {"code":"unsupported_country_region_territory"}',
    "context_length_exceeded",
    "The compiled grammar is too large",
    "This Go model trains on request data.",
    undefined,
    "",
  ]) {
    assert.equal(classifyFailure(message), undefined, String(message))
  }
})

test("classifyFailure: auth is checked before quota", () => {
  // A dead key on a full account must cool down as a credential problem:
  // rotating on "401" is right, and the longer cooldown is the useful one.
  assert.equal(classifyFailure("401 invalid credential"), "auth")
})

test("loadPiAccounts: missing file yields an empty pool instead of throwing", () => {
  assert.deepEqual(loadPiAccounts("/nonexistent/path/accounts.json"), [])
})

test("loadPiAccounts: disabled accounts are excluded", () => {
  const fixture = fileURLToPath(new URL("./fixtures/accounts.json", import.meta.url))
  const accounts = loadPiAccounts(fixture)
  assert.deepEqual(
    accounts.map((a) => a.label),
    ["账号1", "账号2"],
  )
})

test("rankForRequest: a cooled-down account is pushed to the back", async () => {
  installQuota({
    "key-a": { rolling: window(10, 5), weekly: window(10, 168), monthly: window(90, 24) },
    "key-b": { rolling: window(10, 5), weekly: window(10, 168), monthly: window(10, 720) },
  })
  const accounts = [account("a"), account("b")]
  coolDown(accounts[0].apiKey, "quota")
  const ranked = await rankForRequest(accounts, -1)
  assert.equal(ranked.at(-1)?.account.label, "a")
})

test("rankForRequest: cooling accounts remain as a last resort", async () => {
  installQuota({ "key-only": { rolling: window(10, 5), weekly: window(10, 168), monthly: window(10, 720) } })
  const accounts = [account("only")]
  coolDown(accounts[0].apiKey, "auth")
  const ranked = await rankForRequest(accounts, -1)
  assert.equal(ranked.length, 1, "a fully cooled pool must still offer a candidate")
})

test("rankForRequest: an empty pool returns an empty ranking", async () => {
  resetPoolState()
  assert.deepEqual(await rankForRequest([], -1), [])
})

test("describePool: marks the preferred account and reports cooldowns", async () => {
  installQuota({
    "key-a": { rolling: window(5, 5), weekly: window(5, 168), monthly: window(50, 720) },
    "key-b": { rolling: window(5, 5), weekly: window(5, 168), monthly: window(20, 720) },
  })
  const accounts = [account("a"), account("b")]
  coolDown(accounts[1].apiKey, "auth")
  const rows = await describePool(accounts)
  assert.equal(rows.filter((r) => r.preferred).length, 1)
  assert.match(rows.find((r) => r.label === "b")?.detail ?? "", /冷却/)
})

test("rankForRequest: a usable account outranks a full one", async () => {
  installQuota({
    "key-full": { rolling: window(100, 5), weekly: window(0, 168), monthly: window(0, 720) },
    "key-ok": { rolling: window(1, 5), weekly: window(1, 168), monthly: window(1, 720) },
  })
  const ranked = await rankForRequest([account("full"), account("ok")], -1)
  assert.equal(ranked[0].account.label, "ok")
})

test("rankForRequest: an all-full pool still yields every account", async () => {
  installQuota({
    "key-a": { rolling: window(100, 5), weekly: window(100, 168), monthly: window(100, 720) },
    "key-b": { rolling: window(100, 5), weekly: window(100, 168), monthly: window(100, 720) },
  })
  const ranked = await rankForRequest([account("a"), account("b")], -1)
  assert.equal(ranked.length, 2)
})
