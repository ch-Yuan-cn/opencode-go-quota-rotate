import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { join } from "path"
import type { AccountsFile, RotationState } from "./types.ts"

const PERMS = 0o600

function dir(): string {
  return join(process.env.HOME ?? "/root", ".config", "opencode")
}

/** Accounts file — schema-compatible with opencode-go-multi-auth. */
function accountsFile(): string {
  return join(dir(), "opencode-go-accounts.json")
}

/** Rotation state (last used index), survives restarts. */
function stateFile(): string {
  return join(dir(), "opencode-go-quota-rotation.json")
}

function newFile(): AccountsFile {
  return { version: 1, accounts: [], rotationIndex: 0 }
}

function newState(): RotationState {
  return { lastUsedIndex: -1 }
}

/** Atomic write: tmp file with 0o600 perms, then rename over the target. */
function atomicWrite(path: string, data: string): void {
  const d = dir()
  mkdirSync(d, { recursive: true })
  const tmp = path + ".tmp." + process.pid
  writeFileSync(tmp, data, "utf-8")
  chmodSync(tmp, PERMS)
  renameSync(tmp, path)
}

export function loadAccounts(): AccountsFile {
  const f = accountsFile()
  if (!existsSync(f)) return newFile()
  try {
    const raw = readFileSync(f, "utf-8")
    return JSON.parse(raw) as AccountsFile
  } catch {
    // Corrupt file: back it up and start fresh rather than crash the plugin.
    try {
      copyFileSync(f, f + ".bak." + Date.now())
    } catch {
      // ignore backup failure
    }
    return newFile()
  }
}

export function saveAccounts(data: AccountsFile): void {
  atomicWrite(accountsFile(), JSON.stringify(data, null, 2) + "\n")
}

export function loadRotationState(): RotationState {
  const sf = stateFile()
  if (!existsSync(sf)) return newState()
  try {
    const raw = readFileSync(sf, "utf-8")
    return JSON.parse(raw) as RotationState
  } catch {
    return newState()
  }
}

export function saveRotationState(state: RotationState): void {
  atomicWrite(stateFile(), JSON.stringify(state) + "\n")
}