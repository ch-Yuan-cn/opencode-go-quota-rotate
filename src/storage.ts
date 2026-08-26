import type { AccountsFile, RotationState } from "./types"

// TODO(impl): load/save accounts using ~/.config/opencode/opencode-go-accounts.json
// (same schema as opencode-go-multi-auth: { version, accounts[], rotationIndex })
// and rotation state in ~/.config/opencode/opencode-go-quota-rotation.json.
// Use 0o600 permissions and atomic writes (tmp + rename). On corrupt JSON,
// back up the file as .bak.<timestamp> and start fresh.

export function loadAccounts(): AccountsFile {
  throw new Error("not implemented")
}

export function saveAccounts(data: AccountsFile): void {
  void data
  throw new Error("not implemented")
}

export function loadRotationState(): RotationState {
  return { lastUsedIndex: -1 }
}

export function saveRotationState(state: RotationState): void {
  void state
  throw new Error("not implemented")
}
