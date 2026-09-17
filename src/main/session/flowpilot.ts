import { access, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FlowpilotAccount } from "../../shared/contracts.js"

type StoredAccount = {
  id: string
  name: string
  email: string | null
  service?: string
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function defaultFlowpilotRoot(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA
    if (!local) throw new Error("LOCALAPPDATA is unavailable; FlowPilot profiles cannot be located.")
    return path.join(local, "com.flowpilot.desktop")
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "com.flowpilot.desktop")
}

async function exists(target: string): Promise<boolean> {
  try { await access(target, constants.R_OK); return true } catch { return false }
}

export async function listFlowpilotAccounts(root = defaultFlowpilotRoot()): Promise<FlowpilotAccount[]> {
  const accountsPath = path.join(root, "accounts.json")
  if (!(await exists(accountsPath))) return []
  const parsed: unknown = JSON.parse(await readFile(accountsPath, "utf8"))
  if (!Array.isArray(parsed)) throw new Error("FlowPilot accounts.json is not an array.")

  const accounts: FlowpilotAccount[] = []
  for (const row of parsed as StoredAccount[]) {
    if (!row || typeof row.id !== "string" || !SAFE_ID.test(row.id)) continue
    if (row.service !== undefined && row.service !== "flow") continue
    if (typeof row.name !== "string") continue
    const profilePath = path.join(root, "webview-profiles", `flow-${row.id}`)
    if (!(await exists(profilePath))) continue
    accounts.push({ id: row.id, name: row.name, email: typeof row.email === "string" ? row.email : null })
  }
  return accounts
}
