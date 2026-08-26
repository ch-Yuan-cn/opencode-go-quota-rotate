import { appendFileSync, mkdirSync } from "fs"
import { join } from "path"

const dir = join(process.env.HOME ?? "/root", ".config", "opencode")
const file = join(dir, "opencode-go-quota-rotate.log")

let started = false

function ensure() {
  if (started) return
  mkdirSync(dir, { recursive: true })
  started = true
}

/**
 * Append a JSON-lines entry to the plugin log. Never throws: logging is
 * best-effort and must not break auth resolution.
 */
export function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
  ensure()
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  })
  appendFileSync(file, entry + "\n", "utf-8")
}