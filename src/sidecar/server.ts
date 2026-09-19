import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { FlowpilotAccount, QueueEvent, RunSettings } from "../shared/contracts.js"
import { QueueRunner } from "../main/automation/queue-runner.js"
import { listFlowpilotAccounts } from "../main/session/flowpilot.js"
import { logAutomation, logCrash, logDirectory } from "./logger.js"
import type { ApiVaultProgressEvent, ApiVaultRequest } from "../shared/api-vault.js"
import { deleteApiVaultConversation, listApiVaultConversations, listApiVaultModels, runApiVault } from "./api-vault/runner.js"
import type { ApiProvider } from "../shared/api-vault.js"
import { videoSettingsError } from "../shared/video-settings.js"

const tokenIndex = process.argv.indexOf("--token")
const token = tokenIndex >= 0 ? process.argv[tokenIndex + 1] : ""
if (!token || token.length < 32) throw new Error("A strong sidecar authentication token is required.")
const installDirectoryIndex = process.argv.indexOf("--install-dir")
const installDirectory = installDirectoryIndex >= 0 ? process.argv[installDirectoryIndex + 1] : ""
if (!installDirectory) throw new Error("The application installation directory is required.")

let accounts: FlowpilotAccount[] = []
let runner: QueueRunner | null = null
let connectedAccountId: string | null = null
let eventCursor = 0
const events: Array<{ cursor: number; event: QueueEvent }> = []
let apiVaultEventCursor = 0
const apiVaultEvents: Array<{ cursor: number; event: ApiVaultProgressEvent }> = []

const emit = (event: QueueEvent): void => {
  logAutomation("queue.event", { status: event.status, jobId: event.jobId, progress: event.progress, message: event.message })
  eventCursor += 1
  events.push({ cursor: eventCursor, event })
  if (events.length > 1_000) events.splice(0, events.length - 1_000)
}

const emitApiVault = (event: ApiVaultProgressEvent): void => {
  logAutomation("api-vault.progress", { runId: event.runId, phase: event.phase, tool: event.tool, file: event.file })
  apiVaultEventCursor += 1
  apiVaultEvents.push({ cursor: apiVaultEventCursor, event })
  if (apiVaultEvents.length > 1_000) apiVaultEvents.splice(0, apiVaultEvents.length - 1_000)
}

async function closeRunner(): Promise<void> {
  if (!runner) return
  logAutomation("session.close.start")
  runner.stop()
  await runner.close()
  runner = null
  connectedAccountId = null
  logAutomation("session.close.complete")
}

async function request(method: string, params: unknown): Promise<unknown> {
  const input = (params && typeof params === "object" ? params : {}) as Record<string, unknown>
  switch (method) {
    case "accounts:list":
      accounts = await listFlowpilotAccounts()
      logAutomation("accounts.list", { count: accounts.length })
      return accounts
    case "session:status": {
      const accountId = typeof input.accountId === "string" ? input.accountId : ""
      const ready = Boolean(runner && connectedAccountId === accountId)
      logAutomation("session.status", { accountId, ready })
      return ready
    }
    case "session:open": {
      const accountId = typeof input.accountId === "string" ? input.accountId : ""
      const cdpEndpoint = typeof input.cdpEndpoint === "string" ? input.cdpEndpoint : ""
      accounts = await listFlowpilotAccounts()
      const account = accounts.find((candidate) => candidate.id === accountId)
      if (!account) throw new Error("Select a valid Google Flow account from FlowPilot.")
      let endpoint: URL
      try { endpoint = new URL(cdpEndpoint) } catch { throw new Error("FlowPilot did not provide a valid automation endpoint.") }
      if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
        throw new Error("FlowPilot did not provide a safe local automation endpoint.")
      }
      logAutomation("session.open", { accountId, source: "flowpilot-webview2" })
      await closeRunner()
      runner = new QueueRunner(account, cdpEndpoint, emit)
      connectedAccountId = account.id
      return null
    }
    case "queue:start": {
      const settings = input.settings as RunSettings | undefined
      if (!settings || !runner || connectedAccountId !== settings.accountId) throw new Error("The selected FlowPilot session was not prepared. Start the queue again.")
      if (runner.isRunning) throw new Error("A queue is already running for this session.")
      if (!settings.jobs.length || settings.jobs.some((job) => !job.prompt.trim())) throw new Error("Every job requires a prompt.")
      if (settings.output === "video") {
        const hasAssets = settings.jobs.some((job) => job.assets.length > 0)
        const configurationError = videoSettingsError(settings.model, settings.videoDuration, hasAssets)
        if (configurationError) throw new Error(configurationError)
      }
      const activeRunner = runner
      logAutomation("queue.start.accepted", { accountId: settings.accountId, projectMode: settings.projectMode, jobCount: settings.jobs.length })
      void activeRunner.run(settings).catch(async (error) => {
        logAutomation("queue.run.failed", { message: error instanceof Error ? error.message : String(error) })
        emit({ runId: activeRunner.runId, status: "stopped", message: error instanceof Error ? error.message : String(error) })
        if (runner === activeRunner) await closeRunner().catch(() => undefined)
      })
      return { runId: activeRunner.runId }
    }
    case "queue:stop":
      runner?.stop()
      return null
    case "events:poll": {
      const after = typeof input.after === "number" && Number.isSafeInteger(input.after) ? input.after : 0
      return { cursor: eventCursor, events: events.filter((entry) => entry.cursor > after).map((entry) => entry.event) }
    }
    case "api-vault:events:poll": {
      const after = typeof input.after === "number" && Number.isSafeInteger(input.after) ? input.after : 0
      return { cursor: apiVaultEventCursor, events: apiVaultEvents.filter((entry) => entry.cursor > after).map((entry) => entry.event) }
    }
    case "api-vault:run": {
      const settings = input.request as ApiVaultRequest | undefined
      if (!settings || typeof settings !== "object") throw new Error("API Vault request is required.")
      logAutomation("api-vault.run.start", { provider: settings.provider, model: settings.model, mode: settings.executionMode })
      try {
        const result = await runApiVault(installDirectory, settings, emitApiVault)
        logAutomation("api-vault.run.complete", { provider: settings.provider, model: result.model, files: result.files.length })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logAutomation("api-vault.run.failed", { provider: settings.provider, message })
        if (settings.runId) emitApiVault({ runId: settings.runId, phase: "failed", message })
        throw error
      }
    }
    case "api-vault:models": {
      const provider = input.provider as ApiProvider
      const endpoint = typeof input.endpoint === "string" ? input.endpoint : ""
      const apiKey = typeof input.apiKey === "string" ? input.apiKey : ""
      if (!["gemini", "openai", "9router", "custom"].includes(provider) || !endpoint) throw new Error("Provider and endpoint are required to list models.")
      return listApiVaultModels(provider, endpoint, apiKey)
    }
    case "api-vault:conversations:list":
      return listApiVaultConversations(installDirectory)
    case "api-vault:conversations:delete": {
      const id = typeof input.id === "string" ? input.id : ""
      await deleteApiVaultConversation(installDirectory, id)
      return null
    }
    default:
      throw new Error(`Unsupported sidecar method: ${method}`)
  }
}

function authorized(req: IncomingMessage): boolean {
  const value = req.headers.authorization?.replace(/^Bearer\s+/i, "") || ""
  const expected = Buffer.from(token)
  const received = Buffer.from(value)
  return expected.length === received.length && timingSafeEqual(expected, received)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 5 * 1024 * 1024) throw new Error("Request body exceeds 5 MiB.")
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be an object.")
  return parsed as Record<string, unknown>
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" })
  res.end(body)
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/request") return send(res, 404, { ok: false, error: "Not found." })
  if (!authorized(req)) return send(res, 401, { ok: false, error: "Unauthorized." })
  try {
    const body = await readJson(req)
    const method = typeof body.method === "string" ? body.method : ""
    send(res, 200, { ok: true, value: await request(method, body.params) })
  } catch (error) {
    logAutomation("request.failed", { message: error instanceof Error ? error.message : String(error) })
    send(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Sidecar did not bind a TCP port.")
  logAutomation("sidecar.ready", { port: address.port, logDirectory })
  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port })}\n`)
})

const shutdown = async (): Promise<void> => {
  await closeRunner().catch(() => undefined)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 3_000).unref()
}

process.on("SIGINT", () => { void shutdown() })
process.on("SIGTERM", () => { void shutdown() })
process.on("uncaughtException", (error) => {
  logCrash("sidecar.uncaughtException", error)
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exit(1)
})
process.on("unhandledRejection", (error) => {
  logCrash("sidecar.unhandledRejection", error)
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exit(1)
})
