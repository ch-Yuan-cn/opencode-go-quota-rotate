#!/usr/bin/env node
import { Command } from "commander"
import { loadAccounts, saveAccounts, loadRotationState, saveRotationState } from "./storage.ts"
import { queryQuota } from "./quota.ts"
import type { QuotaInfo } from "./types.ts"
import { log } from "./logger.ts"

const program = new Command()

program
  .name("opencode-go-quota-rotate")
  .description("Manage OpenCode Go multi-account quota rotation")
  .version("0.1.0")

function maskKey(key: string): string {
  if (key.length <= 10) return key
  return key.slice(0, 7) + "..." + key.slice(-4)
}

function windowLine(name: string, w: { status?: string; percent?: number; resetsAt?: string } | undefined): string {
  if (!w) return "  " + name + ": n/a"
  const pct = w.percent !== undefined ? w.percent + "%" : "n/a"
  const reset = w.resetsAt ? " (resets " + w.resetsAt + ")" : ""
  return "  " + name + ": " + pct + " " + (w.status ?? "") + reset
}

program
  .command("list")
  .description("Show all configured Go accounts")
  .action(() => {
    const data = loadAccounts()
    if (data.accounts.length === 0) {
      console.log("No Go accounts configured.")
      return
    }
    for (let i = 0; i < data.accounts.length; i++) {
      const a = data.accounts[i]
      const label = a.label || "Account " + (i + 1)
      const status = a.enabled ? "enabled" : "disabled"
      const mark = i === data.rotationIndex ? " <- current" : ""
      console.log("  " + (i + 1) + ". " + label + " [" + status + "] " + maskKey(a.apiKey) + mark)
    }
    log("info", "list", { count: data.accounts.length })
  })

program
  .command("add")
  .description("Add a new Go account")
  .option("-k, --key <key>", "Go API key")
  .option("-l, --label <label>", "Account label")
  .action((opts) => {
    if (!opts.key) {
      console.error("Error: --key is required")
      process.exit(1)
    }
    const data = loadAccounts()
    data.accounts.push({
      apiKey: opts.key.trim(),
      label: opts.label?.trim() || undefined,
      addedAt: Date.now(),
      enabled: true,
    })
    if (data.accounts.length === 1) data.rotationIndex = 0
    saveAccounts(data)
    const label = opts.label?.trim() || "Account " + data.accounts.length
    console.log("Added: " + label)
    log("info", "add", { label, count: data.accounts.length })
  })

program
  .command("remove")
  .description("Remove an account by number (1-based)")
  .argument("<number>", "Account number to remove")
  .action((numStr) => {
    const num = Number.parseInt(numStr, 10) - 1
    const data = loadAccounts()
    if (Number.isNaN(num) || num < 0 || num >= data.accounts.length) {
      console.error("Error: invalid account number \"" + numStr + "\". Choose 1-" + data.accounts.length)
      process.exit(1)
    }
    const removed = data.accounts.splice(num, 1)[0]
    if (data.rotationIndex >= data.accounts.length) {
      data.rotationIndex = Math.max(0, data.accounts.length - 1)
    }
    saveAccounts(data)
    const label = removed.label || "Account " + (num + 1)
    console.log("Removed: " + label)
    log("info", "remove", { label })
  })

program
  .command("status")
  .description("Show rotation state and current account")
  .action(() => {
    const data = loadAccounts()
    const state = loadRotationState()
    const enabled = data.accounts.filter((a) => a.enabled)
    if (enabled.length === 0) {
      console.log("No enabled accounts. Plugin inactive.")
      return
    }
    console.log("Accounts: " + data.accounts.length + " (" + enabled.length + " enabled)")
    console.log("Rotation: " + (data.rotationIndex + 1) + " of " + data.accounts.length)
    console.log("Last used index: " + state.lastUsedIndex)
    log("info", "status", { count: data.accounts.length, rotationIndex: data.rotationIndex })
  })

program
  .command("quota")
  .description("Show live quota for every account (rolling/weekly/monthly)")
  .action(async () => {
    const data = loadAccounts()
    if (data.accounts.length === 0) {
      console.log("No Go accounts configured.")
      return
    }
    const results: { label: string; key: string; quota: QuotaInfo }[] = await Promise.all(
      data.accounts.map(async (a, i) => ({
        label: a.label || "Account " + (i + 1),
        key: a.apiKey,
        quota: await queryQuota(a.apiKey),
      })),
    )
    for (const r of results) {
      console.log(r.label + " " + maskKey(r.key) + (r.quota.error ? " [error: " + r.quota.error + "]" : ""))
      if (!r.quota.error) {
        console.log(windowLine("rolling", r.quota.rolling))
        console.log(windowLine("weekly", r.quota.weekly))
        console.log(windowLine("monthly", r.quota.monthly))
      }
    }
    log("info", "quota", { count: results.length })
  })

program.parse()