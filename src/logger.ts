import { appendFileSync, mkdirSync } from "fs"
import { join } from "path"

// TODO(impl): write JSON lines to ~/.config/opencode/opencode-go-quota-rotate.log
// (mirror the pattern used by opencode-go-multi-auth/src/logger.ts).
// log(level, msg, data?)
export function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
  // placeholder
  void level
  void msg
  void data
  void appendFileSync
  void mkdirSync
  void join
}
