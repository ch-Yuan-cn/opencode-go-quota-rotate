import type { Plugin } from "@opencode-ai/plugin"

// TODO(impl): plugin entry.
//
// auth hook (the core requirement — provider id MUST match paid Go requests):
//   auth: {
//     provider: "opencode-go",          // <-- not "opencode" (see docs/architecture.md)
//     async loader(getAuth) {
//       const data = loadAccounts()
//       if (!enabled accounts) { log("warn", "loader skipped"); return {} }
//       const { account, index, quota, reason } = await pickAccount(data.accounts, state.lastUsedIndex)
//       data.rotationIndex = index
//       saveAccounts(data)
//       saveRotationState({ lastUsedIndex: index })
//       await authClient.auth.set({
//         path: { id: "opencode-go" },
//         body: { type: "api", key: account.apiKey },
//       })
//       const { fetch } = createRotatingFetch(data.accounts)
//       log("info", "loader active", { account, index, weeklyPercent: quota?.weekly?.percent, reason })
//       return { apiKey: "", fetch }   // fetch fully controls Authorization
//     },
//     methods: [ /* "Add Go Account" UI method, same pattern as opencode-go-multi-auth */ ],
//   }
//
// Prerequisite: auth.json must already contain an "opencode-go" entry or the
// loader will not be consulted (OpenCode 1.18.x gating). The loader keeps the
// entry fresh via client.auth.set.

const plugin: Plugin = async () => {
  throw new Error("not implemented")
}

export default plugin
