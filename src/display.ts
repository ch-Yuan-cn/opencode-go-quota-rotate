import type { GoAccount } from "./types.ts"

/** Mask an API key for display: `sk-brav...c3d4`. Never print a whole key. */
export function maskKey(key: string): string {
  if (key.length <= 10) return key
  return key.slice(0, 7) + "..." + key.slice(-4)
}

/** Label to show for an account that carries none of its own. */
export function accountLabel(account: GoAccount, index: number): string {
  return account.label || "Account " + (index + 1)
}

/**
 * The confirmation shown before `remove` deletes an account.
 *
 * It names the account — index, label, masked key and state — rather than just
 * echoing the number back. Labels are user-chosen and can repeat, and the
 * number is easy to mistype, so the name plus the masked key is what actually
 * lets someone see they are about to delete the right one.
 */
export function formatRemovalPrompt(account: GoAccount, index: number): string {
  const state = account.enabled ? "enabled" : "disabled"
  return [
    "About to remove:",
    "  #" + (index + 1) + "  " + accountLabel(account, index) + "  " + maskKey(account.apiKey) + "  [" + state + "]",
    "",
    "Remove this account? [y/N] ",
  ].join("\n")
}
