import { app, BrowserWindow, dialog, ipcMain } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ApiResult, AssetInput, FlowpilotAccount, QueueEvent, RunSettings } from "../shared/contracts.js"
import { listFlowpilotAccounts, snapshotFlowpilotProfile } from "./session/flowpilot.js"
import { QueueRunner } from "./automation/queue-runner.js"
import { AppUpdater } from "./updater.js"

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
let accounts: FlowpilotAccount[] = []
let runner: QueueRunner | null = null
let connectedAccountId: string | null = null
let updater: AppUpdater | null = null

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
const fail = <T>(error: unknown): ApiResult<T> => ({ ok: false, error: error instanceof Error ? error.message : String(error) })

function emit(event: QueueEvent): void { mainWindow?.webContents.send("queue:event", event) }

async function closeRunner(): Promise<void> {
  if (!runner) return
  runner.stop()
  await runner.close()
  runner = null
  connectedAccountId = null
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#0b0f14",
    title: "Kuntyy AutoPrompt",
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const developmentUrl = process.env.VITE_DEV_SERVER_URL
  if (developmentUrl) await mainWindow.loadURL(developmentUrl)
  else await mainWindow.loadFile(path.join(currentDirectory, "../../dist/index.html"))
  updater?.scheduleAutomaticCheck()
}

ipcMain.handle("accounts:list", async () => {
  try { accounts = await listFlowpilotAccounts(); return ok(accounts) } catch (error) { return fail(error) }
})

ipcMain.handle("flow:connect", async (_event, accountId: string) => {
  try {
    const account = accounts.find((candidate) => candidate.id === accountId)
    if (!account) throw new Error("Select a valid FlowPilot Flow account.")
    await closeRunner()
    const snapshot = await snapshotFlowpilotProfile(account, path.join(app.getPath("userData"), "session-snapshots"))
    runner = new QueueRunner(account, snapshot, emit)
    connectedAccountId = account.id
    const controller = await runner.connect()
    return ok(await controller.listProjects())
  } catch (error) { await closeRunner(); return fail(error) }
})

ipcMain.handle("files:assets", async () => {
  try {
    const result = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"], filters: [{ name: "Media", extensions: ["png", "jpg", "jpeg", "webp", "mp4", "mov"] }] })
    if (result.canceled) return ok([])
    return ok(result.filePaths.map((filePath): AssetInput => ({ id: crypto.randomUUID(), path: filePath, name: path.basename(filePath) })))
  } catch (error) { return fail(error) }
})

ipcMain.handle("files:prompts", async () => {
  try {
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Text", extensions: ["txt"] }] })
    if (result.canceled || !result.filePaths[0]) return ok(null)
    const { readFile } = await import("node:fs/promises")
    return ok({ name: path.basename(result.filePaths[0]), text: await readFile(result.filePaths[0], "utf8") })
  } catch (error) { return fail(error) }
})

ipcMain.handle("files:download-directory", async () => {
  try {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
    return ok(result.canceled ? null : result.filePaths[0] || null)
  } catch (error) { return fail(error) }
})

ipcMain.handle("queue:start", async (_event, settings: RunSettings) => {
  try {
    if (!runner || connectedAccountId !== settings.accountId) throw new Error("Connect the selected FlowPilot account before starting the queue.")
    if (!settings.jobs.length || settings.jobs.some((job) => !job.prompt.trim())) throw new Error("Every job requires a prompt.")
    const activeRunner = runner
    void activeRunner.run(settings).catch((error) => emit({ runId: activeRunner.runId, status: "stopped", message: error instanceof Error ? error.message : String(error) }))
    return ok({ runId: activeRunner.runId })
  } catch (error) { return fail(error) }
})

ipcMain.handle("queue:stop", async () => {
  try { runner?.stop(); return ok(undefined) } catch (error) { return fail(error) }
})

app.whenReady().then(async () => {
  updater = new AppUpdater(() => mainWindow)
  updater.registerIpc()
  await createWindow()
})
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit() })
app.on("before-quit", () => { runner?.stop() })
