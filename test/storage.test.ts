import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { loadAccounts, saveAccounts, loadRotationState, saveRotationState } from "../src/storage.ts"

let home: string
let originalHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gqr-storage-"))
  originalHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

function accountsPath(): string {
  return join(home, ".config", "opencode", "opencode-go-accounts.json")
}

test("loadAccounts returns an empty file when missing", () => {
  const data = loadAccounts()
  assert.deepEqual(data.accounts, [])
  assert.equal(data.version, 1)
})

test("saveAccounts/loadAccounts round-trip", () => {
  saveAccounts({
    version: 1,
    accounts: [{ apiKey: "sk-rt", label: "one", addedAt: 123, enabled: true }],
    rotationIndex: 0,
  })
  const data = loadAccounts()
  assert.equal(data.accounts.length, 1)
  assert.equal(data.accounts[0].apiKey, "sk-rt")
  assert.equal(data.accounts[0].label, "one")
})

test("accounts file is written with 0600 permissions", async () => {
  saveAccounts({ version: 1, accounts: [{ apiKey: "sk-perm", addedAt: 0, enabled: true }], rotationIndex: 0 })
  const p = accountsPath()
  const mode = statSync(p).mode & 0o777
  assert.equal(mode, 0o600)
})

test("corrupt accounts file is backed up and fresh data returned", async () => {
  const p = accountsPath()
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(p, "{ not json !!", "utf-8")
  const data = loadAccounts()
  assert.deepEqual(data.accounts, [])
  // A backup must exist
  const bak = readdirSync(join(home, ".config", "opencode"))
  assert.ok(bak.some((f) => f.startsWith("opencode-go-accounts.json.bak.")))
})

test("loadRotationState defaults to -1 when missing", () => {
  assert.equal(loadRotationState().lastUsedIndex, -1)
})

test("saveRotationState/loadRotationState round-trip", () => {
  saveRotationState({ lastUsedIndex: 2 })
  assert.equal(loadRotationState().lastUsedIndex, 2)
})