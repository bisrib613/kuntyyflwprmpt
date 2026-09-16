import { app, type BrowserWindow, ipcMain } from "electron"
import { autoUpdater } from "electron-updater"
import type { ApiResult, UpdateState } from "../shared/contracts.js"

const ok = (): ApiResult<void> => ({ ok: true, value: undefined })
const fail = (error: unknown): ApiResult<void> => ({ ok: false, error: error instanceof Error ? error.message : String(error) })

export class AppUpdater {
  private state: UpdateState = {
    currentVersion: app.getVersion(),
    phase: "idle",
    message: app.isPackaged ? "Updates are checked automatically." : "Update checks are available in packaged builds.",
  }

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.on("checking-for-update", () => this.set({ phase: "checking", message: "Checking GitHub Releases…", percent: undefined }))
    autoUpdater.on("update-available", (info) => this.set({ phase: "available", availableVersion: info.version, message: `Version ${info.version} is available.` }))
    autoUpdater.on("update-not-available", () => this.set({ phase: "up-to-date", availableVersion: undefined, message: "You are using the latest version." }))
    autoUpdater.on("download-progress", (progress) => this.set({ phase: "downloading", percent: Math.round(progress.percent), transferred: progress.transferred, total: progress.total, message: `Downloading update… ${Math.round(progress.percent)}%` }))
    autoUpdater.on("update-downloaded", (info) => this.set({ phase: "downloaded", availableVersion: info.version, percent: 100, message: "Update downloaded. Restart to install it." }))
    autoUpdater.on("error", (error) => this.set({ phase: "error", message: error.message || "Update failed." }))
  }

  registerIpc(): void {
    ipcMain.handle("updates:state", () => this.state)
    ipcMain.handle("updates:check", async () => {
      if (!app.isPackaged) return fail("Update checks require a packaged build.")
      try { await autoUpdater.checkForUpdates(); return ok() } catch (error) { return fail(error) }
    })
    ipcMain.handle("updates:download", async () => {
      if (this.state.phase !== "available") return fail("No update is ready to download.")
      try { await autoUpdater.downloadUpdate(); return ok() } catch (error) { return fail(error) }
    })
    ipcMain.handle("updates:install", () => {
      if (this.state.phase !== "downloaded") return fail("Download the update before installing it.")
      setImmediate(() => autoUpdater.quitAndInstall(false, true))
      return ok()
    })
  }

  scheduleAutomaticCheck(): void {
    if (!app.isPackaged) return
    setTimeout(() => { void autoUpdater.checkForUpdates().catch((error) => this.set({ phase: "error", message: error instanceof Error ? error.message : String(error) })) }, 15_000)
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.getWindow()?.webContents.send("updates:state-changed", this.state)
  }
}
