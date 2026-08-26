import type { Plugin } from "@opencode-ai/plugin"
import { loadAccounts, saveAccounts, loadRotationState, saveRotationState } from "./storage.ts"
import { pickAccount, NoEnabledAccounts } from "./rotate.ts"
import { createRotatingFetch } from "./fetch.ts"
import { log } from "./logger.ts"

/**
 * Plugin entry.
 *
 * The auth hook is the core of this plugin: provider id MUST be "opencode-go"
 * (not "opencode") so OpenCode consults this loader for paid Go requests
 * (e.g. opencode-go/mimo-v2.5). See docs/architecture.md for the verified
 * mechanics on OpenCode 1.18.x.
 */
const plugin: Plugin = async ({ client }) => {
  const authClient = client as any

  return {
    auth: {
      provider: "opencode-go",
      async loader(getAuth) {
        void getAuth
        const data = loadAccounts()
        const state = loadRotationState()

        const enabled = data.accounts.filter((a) => a.enabled)
        if (enabled.length === 0) {
          log("warn", "loader skipped", { reason: "no enabled accounts" })
          return {}
        }

        let account
        let index: number
        let quota
        let reason: string
        try {
          const picked = await pickAccount(data.accounts, state.lastUsedIndex)
          account = picked.account
          index = picked.index
          quota = picked.quota
          reason = picked.reason
        } catch (err) {
          if (err instanceof NoEnabledAccounts) {
            log("warn", "loader skipped", { reason: "no enabled accounts" })
            return {}
          }
          throw err
        }

        data.rotationIndex = index
        saveAccounts(data)
        saveRotationState({ lastUsedIndex: index })

        // Keep the auth.json entry fresh so the loader keeps being consulted.
        try {
          await authClient.auth.set({
            path: { id: "opencode-go" },
            body: { type: "api", key: account.apiKey },
          })
        } catch (err) {
          log("warn", "auth.set failed", { error: String(err) })
        }

        const { fetch } = createRotatingFetch(data.accounts, index)

        log("info", "loader active", {
          account: account.label || "account-" + (index + 1),
          index,
          total: data.accounts.length,
          weeklyPercent: quota?.weekly?.percent,
          rollingPercent: quota?.rolling?.percent,
          reason,
        })

        // apiKey is empty: the fetch wrapper fully controls the Authorization
        // header so failover can swap keys without re-running the loader.
        return {
          apiKey: "",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            return fetch(input, init)
          },
        }
      },
      methods: [
        {
          type: "api",
          label: "Add Go Account",
          prompts: [
            { type: "text", key: "apiKey", message: "Go API key from opencode.ai/auth" },
            { type: "text", key: "label", message: "Label for this account (optional)" },
          ],
          async authorize(inputs) {
            const key = inputs?.apiKey?.trim()
            if (!key) return { type: "failed" }

            const data = loadAccounts()
            const label = inputs?.label?.trim() || undefined
            data.accounts.push({
              apiKey: key,
              label,
              addedAt: Date.now(),
              enabled: true,
            })
            if (data.accounts.length === 1) data.rotationIndex = 0
            saveAccounts(data)

            try {
              await authClient.auth.set({
                path: { id: "opencode-go" },
                body: { type: "api", key },
              })
            } catch (err) {
              log("warn", "auth.set failed in authorize", { error: String(err) })
            }

            log("info", "account added via auth login", {
              label: label || "account-" + data.accounts.length,
              count: data.accounts.length,
            })

            return { type: "success", key }
          },
        },
      ],
    },
  }
}

export default plugin