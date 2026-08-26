/** Account credentials managed by the plugin. */
export interface GoAccount {
  apiKey: string
  label?: string
  addedAt: number
  enabled: boolean
}

/**
 * On-disk accounts file.
 * Format-compatible with opencode-go-multi-auth storage
 * (~/.config/opencode/opencode-go-accounts.json) so existing keys carry over.
 */
export interface AccountsFile {
  version: 1
  accounts: GoAccount[]
  rotationIndex: number
}

/** One usage window reported by the OpenCode Go usage API. */
export interface QuotaWindow {
  status: string
  percent: number
  resetsAt: string
}

/** Parsed response of GET https://opencode.ai/zen/go/v1/usage. */
export interface QuotaInfo {
  rolling?: QuotaWindow
  weekly?: QuotaWindow
  monthly?: QuotaWindow
  error?: string
  fetchedAt: number
}

/** Rotation state persisted between processes. */
export interface RotationState {
  lastUsedIndex: number
}
