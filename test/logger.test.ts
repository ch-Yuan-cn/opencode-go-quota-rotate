import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "../src/logger.ts"

let home: string
let originalHome: string | undefined
let originalLogFile: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gqr-logger-"))
  originalHome = process.env.HOME
  originalLogFile = process.env.OPENCODE_GO_LOG_FILE
  process.env.HOME = home
  delete process.env.OPENCODE_GO_LOG_FILE
})

afterEach(() => {
  process.env.HOME = originalHome
  if (originalLogFile === undefined) delete process.env.OPENCODE_GO_LOG_FILE
  else process.env.OPENCODE_GO_LOG_FILE = originalLogFile
  rmSync(home, { recursive: true, force: true })
})

/** The path the plugin would use under the current HOME. */
function defaultLogPath(): string {
  return join(home, ".config", "opencode", "opencode-go-quota-rotate.log")
}

test("测试进程里默认不写日志：跑测试不会污染使用者的真实日志", () => {
  // 这条测试跑在 node:test 的子进程里，NODE_TEST_CONTEXT 已设置。
  assert.ok(process.env.NODE_TEST_CONTEXT, "expected to run under the node:test runner")
  log("info", "should-not-be-written")
  assert.equal(existsSync(defaultLogPath()), false, "no log file may be created under the default path")
})

test("OPENCODE_GO_LOG_FILE 可以显式把日志重定向到别处", () => {
  const target = join(home, "redirected.log")
  process.env.OPENCODE_GO_LOG_FILE = target
  log("warn", "failover", { from: 0, key: "sk-test-only" })
  assert.equal(existsSync(target), true, "the explicit target must receive the entry")
  const lines = readFileSync(target, "utf-8").trim().split("\n")
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.equal(entry.level, "warn")
  assert.equal(entry.msg, "failover")
  assert.equal(entry.key, "sk-test-only")
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/)
})

test("默认路径按次解析，不是加载时冻结（改 HOME 后写到新位置）", () => {
  // 关掉测试进程的安全网，才能观察默认路径本身；HOME 指向临时目录，仍然安全。
  const savedContext = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  const other = mkdtempSync(join(tmpdir(), "gqr-logger-moved-"))
  try {
    log("info", "first")
    assert.equal(readFileSync(defaultLogPath(), "utf-8").includes("first"), true, "第一次应写到 HOME-A")

    process.env.HOME = other
    log("info", "second")
    const moved = join(other, ".config", "opencode", "opencode-go-quota-rotate.log")
    assert.equal(existsSync(moved), true, "换了 HOME 之后必须写到新位置")
    assert.equal(readFileSync(moved, "utf-8").includes("second"), true)
    // 旧位置不应再被追加（路径确实是每次解析的）
    assert.equal(readFileSync(defaultLogPath(), "utf-8").includes("second"), false)
  } finally {
    process.env.NODE_TEST_CONTEXT = savedContext
    process.env.HOME = home
    rmSync(other, { recursive: true, force: true })
  }
})

test("日志写失败不抛错（这里是路径不可写：指向一个目录）", () => {
  // 指向一个已存在的目录：appendFileSync 会 EISDIR，log() 必须吞掉它。
  process.env.OPENCODE_GO_LOG_FILE = home
  assert.doesNotThrow(() => log("error", "into-a-directory"))
})
