/**
 * Pi extension entry point for the OpenCode Go account pool.
 *
 * This file is bundled to a single self-contained `.js` and copied into
 * `~/.pi/agent/extensions/`, because Pi loads extension files directly with
 * jiti and cannot resolve this repository's TypeScript sources.
 *
 * Everything provider-specific lives in `pi.ts`; this file only bridges Pi's
 * extension API to it: register the provider, wrap the four built-in API
 * implementations with per-request credential selection, add `/pool`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
// The per-API lazy wrappers live on the compat entrypoint (a strict superset of
// the core entrypoint); the root entrypoint exports only `lazyApi`/`lazyStream`.
import {
  anthropicMessagesApi,
  createProvider,
  googleGenerativeAIApi,
  lazyStream,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat"
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all"
import type {
  Api,
  AssistantMessageEvent,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai"

import {
  PI_PROVIDER_ID,
  PI_PROVIDER_NAME,
  classifyFailure,
  coolDown,
  describePool,
  loadPiAccounts,
  rankForRequest,
  resetPoolState,
} from "./pi.ts"

/** Required per-conversation routing header on Go endpoints. */
const SESSION_HEADER = "x-opencode-session"

type AnyStreamOptions = StreamOptions & SimpleStreamOptions

/**
 * Wrap a built-in API implementation so every request resolves its own
 * credential from the pool, and a quota/auth failure rotates inside the same
 * request. Rotation stops once the first event has been yielded: replaying
 * after partial output would duplicate content.
 */
function withAccountPool(streams: ProviderStreams): ProviderStreams {
  async function* runWithPool(
    model: Model<Api>,
    context: TranscriptContext,
    options: AnyStreamOptions | undefined,
    simple: boolean,
  ): AsyncGenerator<AssistantMessageEvent> {
    const signal = options?.signal
    const accounts = loadPiAccounts()
    if (accounts.length === 0) {
      throw new Error(
        "OpenCode Go 账号池为空：检查 ~/.config/opencode/opencode-go-accounts.json",
      )
    }

    const ranked = await rankForRequest(accounts, -1)
    let lastError: string | undefined

    for (let i = 0; i < ranked.length; i++) {
      signal?.throwIfAborted()
      const entry = ranked[i]
      const accountOptions: AnyStreamOptions = {
        ...(options ?? {}),
        apiKey: entry.account.apiKey,
        headers: {
          ...(options?.headers ?? {}),
          ...(options?.sessionId ? { [SESSION_HEADER]: options.sessionId } : {}),
        },
      }

      const inner = simple
        ? streams.streamSimple(model, context, accountOptions)
        : streams.stream(model, context, accountOptions)

      const iterator = inner[Symbol.asyncIterator]()
      let first: IteratorResult<AssistantMessageEvent>
      try {
        first = await iterator.next()
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        const kind = classifyFailure(lastError)
        if (kind && i < ranked.length - 1) {
          coolDown(entry.account.apiKey, kind)
          continue
        }
        throw error
      }

      // An error as the first event means the request failed before any output.
      if (!first.done && first.value.type === "error") {
        lastError = first.value.error?.errorMessage ?? "未知错误"
        const kind = classifyFailure(lastError)
        if (kind && i < ranked.length - 1) {
          coolDown(entry.account.apiKey, kind)
          continue
        }
      }

      if (!first.done) yield first.value
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    }

    throw new Error(
      `账号池里 ${ranked.length} 个账号都没能完成请求。最后一次：${lastError ?? "未知错误"}`,
    )
  }

  const wrap = (
    model: Model<Api>,
    context: TranscriptContext,
    options: AnyStreamOptions | undefined,
    simple: boolean,
  ) => lazyStream(model, async () => runWithPool(model, context, options, simple))

  return {
    ...streams,
    stream: (model, context, options) => wrap(model, context, options as AnyStreamOptions, false),
    streamSimple: (model, context, options) => wrap(model, context, options as AnyStreamOptions, true),
  }
}

export default function (pi: ExtensionAPI): void {
  const baseModels = getBuiltinModels("opencode-go") as readonly Model<Api>[]
  if (baseModels.length === 0) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("opencode-pool：Pi 内置的 opencode-go 模型目录为空，扩展未生效", "error")
    })
    return
  }

  // Reuse Pi's catalog (context windows, pricing, compat flags) under a new
  // provider id so the built-in opencode-go stays usable as a fallback.
  const models = baseModels.map((model) => ({ ...model, provider: PI_PROVIDER_ID }))

  pi.registerProvider(
    createProvider({
      id: PI_PROVIDER_ID,
      name: PI_PROVIDER_NAME,
      auth: {
        apiKey: {
          name: "OpenCode Go 账号池",
          login: async (interaction) => {
            const key = await interaction.prompt({
              type: "secret",
              message: "账号池从 opencode-go-accounts.json 读取，直接回车即可",
            })
            return { type: "api_key", key: key || "pool" }
          },
          // The pool owns the key; this only marks the provider as configured.
          resolve: async () => ({ auth: { apiKey: "pool" }, source: "account pool" }),
        },
      },
      models,
      api: {
        "anthropic-messages": withAccountPool(anthropicMessagesApi()),
        "openai-completions": withAccountPool(openAICompletionsApi()),
        "openai-responses": withAccountPool(openAIResponsesApi()),
        "google-generative-ai": withAccountPool(googleGenerativeAIApi()),
      },
    }),
  )

  pi.registerCommand("pool", {
    description: "查看 OpenCode Go 账号池状态；`/pool reset` 清空冷却与额度缓存",
    handler: async (args, ctx) => {
      if ((args ?? "").trim() === "reset") {
        resetPoolState()
        ctx.ui.notify("账号池：已清空冷却与额度缓存", "info")
        return
      }

      const accounts = loadPiAccounts()
      if (accounts.length === 0) {
        ctx.ui.notify("账号池为空：~/.config/opencode/opencode-go-accounts.json", "error")
        return
      }

      const rows = await describePool(accounts)
      const lines = rows.map((row) => {
        const mark = row.preferred ? "→" : row.cooling ? "·" : " "
        return `${mark} ${row.label}  ${row.detail}`
      })
      ctx.ui.notify(`OpenCode Go 账号池（→ 下一个会用它）\n${lines.join("\n")}`, "info")
    },
  })
}
