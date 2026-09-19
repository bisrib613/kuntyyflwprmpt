import { getVersion } from "@tauri-apps/api/app"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { relaunch } from "@tauri-apps/plugin-process"
import { check, type Update } from "@tauri-apps/plugin-updater"
import type { ApiResult, AssetInput, AutoPromptApi, FlowpilotAccount, PreparedFlowpilotSession, QueueEvent, RunSettings, UpdateState } from "../shared/contracts"
import type { ApiVaultAsset, ApiVaultConversation, ApiVaultProgressEvent, ApiVaultSettings } from "../shared/api-vault"

type SidecarEnvelope<T> = ApiResult<T>
type EventBatch = { cursor: number; events: QueueEvent[] }
type ApiVaultEventBatch = { cursor: number; events: ApiVaultProgressEvent[] }

const sidecar = <T>(method: string, params: Record<string, unknown> = {}): Promise<SidecarEnvelope<T>> =>
  invoke("sidecar_request", { method, params })

const updateListeners = new Set<(state: UpdateState) => void>()
let pendingUpdate: Update | null = null
let updateState: UpdateState = { currentVersion: "0.0.0", phase: "idle", message: "Updates are checked automatically." }
let updateCheck: Promise<ApiResult<void>> | null = null
const updateRetryDelays = [1_500, 4_000]
const updateCheckTimeout = 15_000
const updateDownloadTimeout = 120_000

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: number | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = window.setTimeout(() => reject(new Error(message)), milliseconds) }),
    ])
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

function retryableUpdateDownload(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:404|408|429|500|502|503|504)\b/.test(message)
}

function publishUpdate(patch: Partial<UpdateState>): void {
  updateState = { ...updateState, ...patch }
  updateListeners.forEach((listener) => listener(updateState))
}

function recordUpdaterEvent(event: string, message: string): void {
  void invoke("record_updater_event", { event, message }).catch(() => undefined)
}

async function replacePendingUpdate(next: Update | null): Promise<void> {
  const previous = pendingUpdate
  pendingUpdate = next
  if (previous && previous !== next) await previous.close().catch(() => undefined)
}

async function performUpdateCheck(): Promise<ApiResult<void>> {
  try {
    publishUpdate({ phase: "checking", message: "Checking GitHub Releases…", percent: undefined })
    recordUpdaterEvent("update.check.start", "Checking GitHub Releases")
    const update = await check({ timeout: updateCheckTimeout })
    await replacePendingUpdate(update)
    if (!update) {
      publishUpdate({ phase: "up-to-date", availableVersion: undefined, message: "You are using the latest version." })
      recordUpdaterEvent("update.check.complete", "No update available")
      return { ok: true, value: undefined }
    }
    publishUpdate({ phase: "available", availableVersion: update.version, message: `Version ${update.version} is available.` })
    recordUpdaterEvent("update.check.available", `version=${update.version}`)
    return { ok: true, value: undefined }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    publishUpdate({ phase: "error", message })
    recordUpdaterEvent("update.check.failed", message)
    return { ok: false, error: message }
  }
}

function checkForUpdates(): Promise<ApiResult<void>> {
  if (updateCheck) return updateCheck
  updateCheck = performUpdateCheck().finally(() => { updateCheck = null })
  return updateCheck
}

async function downloadUpdate(): Promise<ApiResult<void>> {
  if (!pendingUpdate) return { ok: false, error: "No update is ready to download." }
  let transferred = 0
  let total: number | undefined
  try {
    for (let attempt = 0; ; attempt += 1) {
      transferred = 0
      total = undefined
      publishUpdate({ phase: "downloading", percent: 0, transferred, total, message: attempt === 0 ? "Downloading update… 0%" : `Retrying update download (${attempt + 1}/${updateRetryDelays.length + 1})…` })
      recordUpdaterEvent("update.download.start", `attempt=${attempt + 1}`)
      try {
        await pendingUpdate.download((event) => {
          if (event.event === "Started") total = event.data.contentLength ?? undefined
          if (event.event === "Progress") transferred += event.data.chunkLength
          const percent = total ? Math.min(100, Math.round((transferred / total) * 100)) : undefined
          publishUpdate({ phase: "downloading", percent, transferred, total, message: percent === undefined ? "Downloading update…" : `Downloading update… ${percent}%` })
        }, { timeout: updateDownloadTimeout })
        break
      } catch (error) {
        if (!retryableUpdateDownload(error) || attempt >= updateRetryDelays.length) throw error
        publishUpdate({ phase: "downloading", percent: 0, transferred: 0, total: undefined, message: "GitHub is still preparing the release asset. Retrying automatically…" })
        await wait(updateRetryDelays[attempt])
        const refreshed = await check({ timeout: updateCheckTimeout })
        if (!refreshed) throw new Error("The update release is no longer available.")
        await replacePendingUpdate(refreshed)
      }
    }
    publishUpdate({ phase: "downloaded", percent: 100, transferred, total, message: "Download complete. Restart and install when ready." })
    recordUpdaterEvent("update.download.complete", `bytes=${transferred}`)
    return { ok: true, value: undefined }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    const message = retryableUpdateDownload(error) ? `GitHub did not make the installer available after ${updateRetryDelays.length + 1} attempts. Please try again in a moment. (${raw})` : raw
    publishUpdate({ phase: "error", message })
    recordUpdaterEvent("update.download.failed", message)
    return { ok: false, error: message }
  }
}

const api: AutoPromptApi = {
  listAccounts: () => sidecar<FlowpilotAccount[]>("accounts:list"),
  pickAssets: async () => {
    try {
      const selected = await open({ multiple: true, filters: [{ name: "Media", extensions: ["png", "jpg", "jpeg", "webp", "mp4", "mov"] }] })
      const paths = selected ? (Array.isArray(selected) ? selected : [selected]) : []
      return { ok: true, value: paths.map((filePath): AssetInput => ({ id: crypto.randomUUID(), path: filePath, name: filePath.split(/[\\/]/).pop() || filePath })) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  pickPromptFile: async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: "Text", extensions: ["txt"] }] })
      if (!selected) return { ok: true, value: null }
      const text = await invoke<string>("read_prompt_file", { path: selected })
      return { ok: true, value: { name: selected.split(/[\\/]/).pop() || selected, text } }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  pickDownloadDirectory: async () => {
    try { return { ok: true, value: await open({ directory: true, multiple: false }) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  pickApiVaultAssets: async () => {
    try {
      const selected = await open({ multiple: true, filters: [{ name: "Images and documents", extensions: ["png", "jpg", "jpeg", "webp", "gif", "txt", "md", "markdown", "json", "csv", "tsv", "pdf", "docx"] }] })
      const paths = selected ? (Array.isArray(selected) ? selected : [selected]) : []
      const imageExtensions = new Set(["png", "jpg", "jpeg", "webp", "gif"])
      return { ok: true, value: paths.map((filePath): ApiVaultAsset => {
        const name = filePath.split(/[\\/]/).pop() || filePath
        const extension = name.split(".").pop()?.toLowerCase() || ""
        return { id: crypto.randomUUID(), path: filePath, name, kind: imageExtensions.has(extension) ? "image" : "document" }
      }) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  pickApiVaultTextFile: async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: "Prompt text", extensions: ["txt", "md", "markdown"] }] })
      if (!selected) return { ok: true, value: null }
      const text = await invoke<string>("read_prompt_file", { path: selected })
      return { ok: true, value: { name: selected.split(/[\\/]/).pop() || selected, text } }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  runApiVault: (request) => sidecar("api-vault:run", { request }),
  onApiVaultProgress: (listener) => {
    let cursor = 0
    let stopped = false
    let polling = false
    const poll = async () => {
      if (stopped || polling) return
      polling = true
      try {
        const result = await sidecar<ApiVaultEventBatch>("api-vault:events:poll", { after: cursor })
        if (result.ok) {
          cursor = result.value.cursor
          result.value.events.forEach(listener)
        }
      } catch { /* the active API request reports transport failures */
      } finally { polling = false }
    }
    const interval = window.setInterval(() => { void poll() }, 300)
    void poll()
    return () => { stopped = true; window.clearInterval(interval) }
  },
  listApiVaultConversations: () => sidecar<ApiVaultConversation[]>("api-vault:conversations:list"),
  deleteApiVaultConversation: async (id) => {
    const result = await sidecar<null>("api-vault:conversations:delete", { id })
    return result.ok ? { ok: true, value: undefined } : result
  },
  loadApiVaultSettings: async () => {
    try { return { ok: true, value: await invoke<ApiVaultSettings | null>("load_api_vault_settings") } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  saveApiVaultSettings: async (settings) => {
    try { await invoke("save_api_vault_settings", { settings }); return { ok: true, value: undefined } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  listApiVaultModels: (provider, endpoint, apiKey) => sidecar("api-vault:models", { provider, endpoint, apiKey }),
  saveApiVaultResult: async (directory, filename, content, format) => {
    try { return { ok: true, value: await invoke<string>("save_api_vault_result", { directory, filename, content, format }) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  getLogDirectory: async () => {
    try { return { ok: true, value: await invoke<string>("get_log_directory") } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  openLogDirectory: async () => {
    try { await invoke("open_log_directory"); return { ok: true, value: undefined } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  startRun: async (settings: RunSettings) => {
    try {
      const status = await sidecar<boolean>("session:status", { accountId: settings.accountId })
      if (!status.ok) return status
      if (!status.value) {
        const session = await withTimeout(
          invoke<PreparedFlowpilotSession>("prepare_flowpilot_session", { accountId: settings.accountId }),
          30_000,
          "FlowPilot session preparation exceeded 30 seconds. Restart the app, try again, then inspect automation.log if it repeats.",
        )
        const opened = await sidecar<null>("session:open", { accountId: settings.accountId, ...session })
        if (!opened.ok) return opened
      }
      return sidecar<{ runId: string }>("queue:start", { settings })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
  stopRun: async () => {
    const result = await sidecar<null>("queue:stop")
    return result.ok ? { ok: true, value: undefined } : result
  },
  onQueueEvent: (listener) => {
    let cursor = 0
    let stopped = false
    let polling = false
    let reportedFailure = false
    const poll = async () => {
      if (stopped || polling) return
      polling = true
      try {
        const result = await sidecar<EventBatch>("events:poll", { after: cursor })
        if (result.ok) {
          reportedFailure = false
          cursor = result.value.cursor
          result.value.events.forEach(listener)
        } else if (!reportedFailure) {
          reportedFailure = true
          listener({ runId: "runtime", status: "stopped", message: result.error })
        }
      } catch (error) {
        if (!reportedFailure) {
          reportedFailure = true
          listener({ runId: "runtime", status: "stopped", message: error instanceof Error ? error.message : String(error) })
        }
      } finally { polling = false }
    }
    const interval = window.setInterval(() => { void poll() }, 500)
    void poll()
    return () => { stopped = true; window.clearInterval(interval) }
  },
  getUpdateState: async () => {
    updateState = { ...updateState, currentVersion: await getVersion() }
    return updateState
  },
  checkForUpdates,
  downloadUpdate,
  installUpdate: async () => {
    if (!pendingUpdate) return { ok: false, error: "No downloaded update is ready to install." }
    try {
      publishUpdate({ phase: "installing", message: "Installing update…" })
      recordUpdaterEvent("update.install.start", pendingUpdate.version)
      await pendingUpdate.install({ restartAfterInstall: true })
      publishUpdate({ phase: "restarting", message: "Restarting with the new version…" })
      recordUpdaterEvent("update.install.complete", pendingUpdate.version)
      await relaunch()
      return { ok: true, value: undefined }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      publishUpdate({ phase: "error", message })
      recordUpdaterEvent("update.install.failed", message)
      return { ok: false, error: message }
    }
  },
  onUpdateState: (listener) => {
    updateListeners.add(listener)
    return () => { updateListeners.delete(listener) }
  },
}

window.autoPrompt = api
