import { contextBridge, ipcRenderer } from "electron"
import type { AutoPromptApi, QueueEvent, RunSettings, UpdateState } from "../shared/contracts.js"

const api: AutoPromptApi = {
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  connect: (accountId) => ipcRenderer.invoke("flow:connect", accountId),
  pickAssets: () => ipcRenderer.invoke("files:assets"),
  pickPromptFile: () => ipcRenderer.invoke("files:prompts"),
  pickDownloadDirectory: () => ipcRenderer.invoke("files:download-directory"),
  startRun: (settings: RunSettings) => ipcRenderer.invoke("queue:start", settings),
  stopRun: () => ipcRenderer.invoke("queue:stop"),
  onQueueEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: QueueEvent) => listener(payload)
    ipcRenderer.on("queue:event", handler)
    return () => ipcRenderer.removeListener("queue:event", handler)
  },
  getUpdateState: () => ipcRenderer.invoke("updates:state"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: UpdateState) => listener(payload)
    ipcRenderer.on("updates:state-changed", handler)
    return () => ipcRenderer.removeListener("updates:state-changed", handler)
  },
}

contextBridge.exposeInMainWorld("autoPrompt", api)
