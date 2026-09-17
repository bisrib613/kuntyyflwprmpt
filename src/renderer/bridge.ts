import { getVersion } from "@tauri-apps/api/app"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { relaunch } from "@tauri-apps/plugin-process"
import { check, type Update } from "@tauri-apps/plugin-updater"
import type { ApiResult, AssetInput, AutoPromptApi, FlowProject, FlowpilotAccount, PreparedFlowpilotSession, QueueEvent, RunSettings, UpdateState } from "../shared/contracts"

type SidecarEnvelope<T> = ApiResult<T>
type EventBatch = { cursor: number; events: QueueEvent[] }

const sidecar = <T>(method: string, params: Record<string, unknown> = {}): Promise<SidecarEnvelope<T>> =>
  invoke("sidecar_request", { method, params })

const updateListeners = new Set<(state: UpdateState) => void>()
let pendingUpdate: Update | null = null
let updateState: UpdateState = { currentVersion: "0.0.0", phase: "idle", message: "Updates are checked automatically." }
const updateRetryDelays = [1_500, 4_000]

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

function retryableUpdateDownload(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:404|408|429|500|502|503|504)\b/.test(message)
}

function publishUpdate(patch: Partial<UpdateState>): void {
  updateState = { ...updateState, ...patch }
  updateListeners.forEach((listener) => listener(updateState))
}

async function checkForUpdates(): Promise<ApiResult<void>> {
  try {
    publishUpdate({ phase: "checking", message: "Checking GitHub Releases…", percent: undefined })
    pendingUpdate = await check()
    if (!pendingUpdate) {
      publishUpdate({ phase: "up-to-date", availableVersion: undefined, message: "You are using the latest version." })
      return { ok: true, value: undefined }
    }
    publishUpdate({ phase: "available", availableVersion: pendingUpdate.version, message: `Version ${pendingUpdate.version} is available.` })
    return { ok: true, value: undefined }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    publishUpdate({ phase: "error", message })
    return { ok: false, error: message }
  }
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
      try {
        await pendingUpdate.downloadAndInstall((event) => {
          if (event.event === "Started") total = event.data.contentLength ?? undefined
          if (event.event === "Progress") transferred += event.data.chunkLength
          const percent = total ? Math.min(100, Math.round((transferred / total) * 100)) : undefined
          publishUpdate({ phase: "downloading", percent, transferred, total, message: percent === undefined ? "Downloading update…" : `Downloading update… ${percent}%` })
        })
        break
      } catch (error) {
        if (!retryableUpdateDownload(error) || attempt >= updateRetryDelays.length) throw error
        publishUpdate({ phase: "downloading", percent: 0, transferred: 0, total: undefined, message: "GitHub is still preparing the release asset. Retrying automatically…" })
        await wait(updateRetryDelays[attempt])
        const refreshed = await check()
        if (!refreshed) throw new Error("The update release is no longer available.")
        pendingUpdate = refreshed
      }
    }
    publishUpdate({ phase: "downloaded", percent: 100, transferred, total, message: "Update installed. Restart to use it." })
    return { ok: true, value: undefined }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    const message = retryableUpdateDownload(error) ? `GitHub did not make the installer available after ${updateRetryDelays.length + 1} attempts. Please try again in a moment. (${raw})` : raw
    publishUpdate({ phase: "error", message })
    return { ok: false, error: message }
  }
}

const api: AutoPromptApi = {
  listAccounts: () => sidecar<FlowpilotAccount[]>("accounts:list"),
  connect: async (accountId) => {
    try {
      const session = await invoke<PreparedFlowpilotSession>("prepare_flowpilot_session", { accountId })
      return sidecar<FlowProject[]>("flow:connect", { accountId, ...session })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
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
  startRun: (settings: RunSettings) => sidecar<{ runId: string }>("queue:start", { settings }),
  stopRun: async () => {
    const result = await sidecar<null>("queue:stop")
    return result.ok ? { ok: true, value: undefined } : result
  },
  onQueueEvent: (listener) => {
    let cursor = 0
    let stopped = false
    let polling = false
    const poll = async () => {
      if (stopped || polling) return
      polling = true
      try {
        const result = await sidecar<EventBatch>("events:poll", { after: cursor })
        if (result.ok) {
          cursor = result.value.cursor
          result.value.events.forEach(listener)
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
    try { await relaunch(); return { ok: true, value: undefined } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  },
  onUpdateState: (listener) => {
    updateListeners.add(listener)
    return () => { updateListeners.delete(listener) }
  },
}

window.autoPrompt = api
