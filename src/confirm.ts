import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"

/** Streams a prompt reads from and writes to. Injected so tests need no real terminal. */
export interface PromptStreams {
  input: Readable
  output: Writable
}

/**
 * Whether an answer to a yes/no prompt means "yes".
 *
 * Only an explicit `y` or `yes` counts, in any case and ignoring surrounding
 * whitespace. A bare Enter, `n`, or anything unrecognised is a refusal, so a
 * stray keystroke can never delete an account — the prompt fails closed.
 */
export function isAffirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase()
  return normalized === "y" || normalized === "yes"
}

/**
 * Ask a yes/no question on the terminal.
 *
 * Returns `false` when the prompt ends without an answer (EOF, Ctrl+D, closed
 * input), so an interrupted read is never mistaken for confirmation.
 *
 * Two details here are load-bearing, both found by tests:
 *
 * - The `close` fallback: when the input ends, `readline/promises`'
 *   `question()` promise neither resolves nor rejects — it is abandoned — so
 *   waiting on it alone hangs the CLI forever after Ctrl+D.
 * - The callback form of `question()`: its promise resolves through a
 *   microtask, which loses the race against the `close` event that fires as
 *   soon as the input stream ends (a pipe carrying `y\n` ends immediately), so
 *   a genuine "yes" was being read as "no". The callback runs synchronously
 *   while readline emits the line, so a real answer always wins.
 */
export async function confirm(question: string, streams?: PromptStreams): Promise<boolean> {
  const input = streams?.input ?? process.stdin
  const output = streams?.output ?? process.stdout
  const rl = createInterface({ input, output })
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (value: boolean): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      rl.once("close", () => settle(false))
      rl.question(question, (answer) => settle(isAffirmative(answer)))
    })
  } finally {
    rl.close()
  }
}
