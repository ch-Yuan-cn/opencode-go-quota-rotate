import { appendFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"

/**
 * Where the plugin log goes, resolved **per call**.
 *
 * Resolving at import time (the previous behaviour) froze the path on the first
 * load, which is how `npm test` ended up appending its own failover records to
 * the developer's real `~/.config/opencode/opencode-go-quota-rotate.log`:
 * `storage.ts` resolves every path it owns per call, so a test that repoints
 * `HOME` gets an isolated view of the accounts file while the logger kept
 * writing to the real one.
 *
 * Precedence:
 * 1. `OPENCODE_GO_LOG_FILE` — explicit redirect (unusual `HOME`, read-only config
 *    directory, or a test that wants to assert on the log).
 * 2. Nothing at all inside a test process, so a suite can never write to a user's
 *    log; `node --test` marks its children with `NODE_TEST_CONTEXT`, and passing
 *    `OPENCODE_GO_LOG_FILE` above is how a test opts back in.
 * 3. `<HOME>/.config/opencode/opencode-go-quota-rotate.log`.
 *
 * @returns the log path, or `undefined` when logging is switched off.
 */
function logFile(): string | undefined {
  const override = process.env.OPENCODE_GO_LOG_FILE
  if (typeof override === "string" && override.trim() !== "") return override.trim()
  const testContext = process.env.NODE_TEST_CONTEXT
  if (typeof testContext === "string" && testContext !== "") return undefined
  return join(process.env.HOME ?? "/root", ".config", "opencode", "opencode-go-quota-rotate.log")
}

/** Directories already created, so a busy log does not stat the filesystem each line. */
const ready = new Set<string>()

/**
 * Append a JSON-lines entry to the plugin log.
 *
 * Never throws: logging is best-effort and must not break auth resolution or
 * account selection, so a read-only or unwritable log location degrades to
 * silence rather than to a failed request.
 */
export function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
  try {
    const file = logFile()
    if (file === undefined) return
    const dir = dirname(file)
    if (!ready.has(dir)) {
      mkdirSync(dir, { recursive: true })
      ready.add(dir)
    }
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...data,
    })
    appendFileSync(file, entry + "\n", "utf-8")
  } catch {
    // Logging must never be the reason a request fails.
  }
}
