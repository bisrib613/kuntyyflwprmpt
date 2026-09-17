import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import os from "node:os"
import type { BrowserCookie, FlowpilotAccount, QueueEvent, RunSettings } from "../shared/contracts.js"
import { QueueRunner } from "../main/automation/queue-runner.js"
import { listFlowpilotAccounts } from "../main/session/flowpilot.js"

const tokenIndex = process.argv.indexOf("--token")
const token = tokenIndex >= 0 ? process.argv[tokenIndex + 1] : ""
if (!token || token.length < 32) throw new Error("A strong sidecar authentication token is required.")

let accounts: FlowpilotAccount[] = []
let runner: QueueRunner | null = null
let connectedAccountId: string | null = null
let eventCursor = 0
const events: Array<{ cursor: number; event: QueueEvent }> = []

const emit = (event: QueueEvent): void => {
  eventCursor += 1
  events.push({ cursor: eventCursor, event })
  if (events.length > 1_000) events.splice(0, events.length - 1_000)
}

async function closeRunner(): Promise<void> {
  if (!runner) return
  runner.stop()
  await runner.close()
  runner = null
  connectedAccountId = null
}

async function request(method: string, params: unknown): Promise<unknown> {
  const input = (params && typeof params === "object" ? params : {}) as Record<string, unknown>
  switch (method) {
    case "accounts:list":
      accounts = await listFlowpilotAccounts()
      return accounts
    case "flow:connect": {
      const accountId = typeof input.accountId === "string" ? input.accountId : ""
      const profilePath = typeof input.profilePath === "string" ? input.profilePath : ""
      const cookies = Array.isArray(input.cookies) ? input.cookies as BrowserCookie[] : []
      accounts = await listFlowpilotAccounts()
      const account = accounts.find((candidate) => candidate.id === accountId)
      if (!account) throw new Error("Select a valid Google Flow account from FlowPilot.")
      const snapshotRoot = path.join(os.tmpdir(), "kuntyy-autoprompt-sessions")
      const relative = path.relative(snapshotRoot, profilePath)
      if (!profilePath || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid temporary automation profile path.")
      if (!cookies.length || cookies.some((cookie) => !cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string" || typeof cookie.domain !== "string")) {
        throw new Error("FlowPilot did not provide a valid signed-in Google session.")
      }
      await closeRunner()
      runner = new QueueRunner(account, profilePath, cookies, emit)
      connectedAccountId = account.id
      return (await runner.connect()).listProjects()
    }
    case "queue:start": {
      const settings = input.settings as RunSettings | undefined
      if (!settings || !runner || connectedAccountId !== settings.accountId) throw new Error("Connect the selected FlowPilot account before starting the queue.")
      if (runner.isRunning) throw new Error("A queue is already running for this session.")
      if (!settings.jobs.length || settings.jobs.some((job) => !job.prompt.trim())) throw new Error("Every job requires a prompt.")
      const activeRunner = runner
      void activeRunner.run(settings).catch((error) => emit({
        runId: activeRunner.runId,
        status: "stopped",
        message: error instanceof Error ? error.message : String(error),
      }))
      return { runId: activeRunner.runId }
    }
    case "queue:stop":
      runner?.stop()
      return null
    case "events:poll": {
      const after = typeof input.after === "number" && Number.isSafeInteger(input.after) ? input.after : 0
      return { cursor: eventCursor, events: events.filter((entry) => entry.cursor > after).map((entry) => entry.event) }
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
    send(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Sidecar did not bind a TCP port.")
  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port })}\n`)
})

const shutdown = async (): Promise<void> => {
  await closeRunner().catch(() => undefined)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 3_000).unref()
}

process.on("SIGINT", () => { void shutdown() })
process.on("SIGTERM", () => { void shutdown() })
