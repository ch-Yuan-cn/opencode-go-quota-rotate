import { test } from "node:test"
import assert from "node:assert/strict"
import { Readable, Writable } from "node:stream"
import { confirm, isAffirmative } from "../src/confirm.ts"
import { accountLabel, formatRemovalPrompt, maskKey } from "../src/display.ts"
import type { GoAccount } from "../src/types.ts"

/** Fake terminal: `input` is what the user types, `output` collects what they'd see. */
function fakeTerminal(input: string): { input: Readable; output: Writable; shown: () => string } {
  const chunks: string[] = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  return { input: Readable.from(input === "" ? [] : [input]), output, shown: () => chunks.join("") }
}

const ACCOUNT: GoAccount = { apiKey: "sk-bravoXXXXXXXXXXXXXXXXXXXc3d4", label: "account 2", addedAt: 0, enabled: true }

// ---------------------------------------------------------------------------
// isAffirmative：只有明确的 y/yes 才算确认
// ---------------------------------------------------------------------------

test("isAffirmative: y / yes（任意大小写、前后空白）算确认", () => {
  for (const answer of ["y", "Y", "yes", "YES", "Yes", "  y  ", "y\n", "\tyes\t"]) {
    assert.equal(isAffirmative(answer), true, JSON.stringify(answer))
  }
})

test("isAffirmative: 直接回车 / n / 其它任何输入都不算确认", () => {
  for (const answer of ["", " ", "\n", "n", "N", "no", "NO", "yeah", "yep", "ok", "1", "删除"]) {
    assert.equal(isAffirmative(answer), false, JSON.stringify(answer))
  }
})

// ---------------------------------------------------------------------------
// confirm：默认拒绝，读不到回答也不确认
// ---------------------------------------------------------------------------

test("confirm: 输入 y 返回 true，并且问题确实被写到了终端", async () => {
  const terminal = fakeTerminal("y\n")
  assert.equal(await confirm("Remove this account? [y/N] ", terminal), true)
  assert.match(terminal.shown(), /Remove this account\?/)
})

test("confirm: 输入 n 返回 false", async () => {
  assert.equal(await confirm("q? ", fakeTerminal("n\n")), false)
})

test("confirm: 直接回车（默认 N）返回 false", async () => {
  assert.equal(await confirm("q? ", fakeTerminal("\n")), false)
})

test("confirm: 输入流直接结束（EOF）返回 false，而不是挂住或误判为确认", async () => {
  assert.equal(await confirm("q? ", fakeTerminal("")), false)
})

// ---------------------------------------------------------------------------
// 删除确认文案：必须点名账号，且不能泄露完整 key
// ---------------------------------------------------------------------------

test("formatRemovalPrompt: 显示编号、账号名、脱敏 key 与启用状态", () => {
  const text = formatRemovalPrompt(ACCOUNT, 1)
  assert.match(text, /About to remove:/)
  assert.match(text, /#2/)
  assert.match(text, /account 2/)
  assert.match(text, /sk-brav\.\.\.c3d4/)
  assert.match(text, /\[enabled\]/)
  assert.match(text, /\[y\/N\]/)
})

test("formatRemovalPrompt: 绝不出现完整 key", () => {
  assert.ok(!formatRemovalPrompt(ACCOUNT, 1).includes(ACCOUNT.apiKey))
})

test("formatRemovalPrompt: 无 label 的账号退化成 Account <n>，状态显示 disabled", () => {
  const anonymous: GoAccount = { apiKey: "sk-abcdefghijklmnop", addedAt: 0, enabled: false }
  const text = formatRemovalPrompt(anonymous, 0)
  assert.match(text, /#1/)
  assert.match(text, /Account 1/)
  assert.match(text, /\[disabled\]/)
})

test("maskKey / accountLabel", () => {
  assert.equal(maskKey(ACCOUNT.apiKey), "sk-brav...c3d4")
  assert.equal(maskKey("short"), "short")
  assert.equal(accountLabel(ACCOUNT, 1), "account 2")
  assert.equal(accountLabel({ apiKey: "k", addedAt: 0, enabled: true }, 2), "Account 3")
})
