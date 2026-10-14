import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import type {
  ApiProvider,
  ApiVaultAsset,
  ApiVaultSettings,
  ApiVaultTelegramApprovedChat,
  ApiVaultTelegramBotInfo,
  ApiVaultTelegramCandidate,
  ApiVaultTelegramStatus,
} from "../../shared/api-vault.js"
import { listApiVaultConversations, runApiVault, type ApiVaultRunControl } from "./runner.js"

type TelegramEnvelope<T> = { ok: boolean; result?: T; description?: string; error_code?: number }
type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string }
type TelegramChat = { id: number; type: string; first_name?: string; last_name?: string; username?: string }
type TelegramPhoto = { file_id: string; file_size?: number; width: number; height: number }
type TelegramDocument = { file_id: string; file_name?: string; file_size?: number; mime_type?: string }
type TelegramMessage = { message_id: number; text?: string; caption?: string; from?: TelegramUser; chat: TelegramChat; photo?: TelegramPhoto[]; document?: TelegramDocument }
type TelegramCallbackQuery = { id: string; from: TelegramUser; data?: string; message?: TelegramMessage }
type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }
type TelegramFile = { file_id: string; file_path?: string; file_size?: number }
type TelegramSession = { executionMode: "agent" | "independent"; conversationId?: string }
type TelegramDiskState = { offset?: number; sessions?: Record<string, TelegramSession> }
type PendingApproval = { userId: number; chatId: number; resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
type TelegramRuntime = {
  installDirectory: string
  settings: ApiVaultSettings
  token: string
  controller: AbortController
  bot: ApiVaultTelegramBotInfo
  status: ApiVaultTelegramStatus
  offset: number
  sessions: Record<string, TelegramSession>
  statePath: string
  activeRuns: Map<string, AbortController>
  pendingApprovals: Map<string, PendingApproval>
  pollPromise?: Promise<void>
}
type TelegramCallResult<T> = { result: T }

let runtime: TelegramRuntime | undefined

const supportedDocumentExtensions = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".pdf", ".docx",
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
])
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"])
const MAX_INCOMING_FILE_BYTES = 10 * 1024 * 1024
const MAX_OUTGOING_FILE_BYTES = 20 * 1024 * 1024
const TELEGRAM_MAX_MESSAGE_CHARS = 3_500

function peerKey(userId: number, chatId: number): string {
  return String(userId) + ":" + String(chatId)
}

function safeStatus(value: TelegramRuntime): ApiVaultTelegramStatus {
  return {
    running: value.status.running,
    pairingUntil: value.status.pairingUntil,
    bot: value.status.bot,
    candidates: value.status.candidates.map((item) => ({ ...item })),
    approvedChats: value.status.approvedChats.map((item) => ({ ...item })),
    lastError: value.status.lastError,
  }
}

function signalFor(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs)
}

async function telegramCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const url = "https://api.telegram.org/bot" + token + "/" + method
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signalFor(35_000, signal),
    })
  } catch (error) {
    if (signal?.aborted) throw new Error("Telegram operation was cancelled.")
    throw new Error("Telegram Bot API request failed: " + (error instanceof Error ? error.message : String(error)).replaceAll(token, "[redacted]"))
  }
  const envelope = await response.json().catch(() => ({})) as TelegramEnvelope<T>
  if (!response.ok || !envelope.ok || envelope.result === undefined) {
    const description = typeof envelope.description === "string" ? envelope.description : "Telegram Bot API " + method + " failed."
    throw new Error(description.replaceAll(token, "[redacted]"))
  }
  return envelope.result
}

export async function validateApiVaultTelegramBot(token: string): Promise<ApiVaultTelegramBotInfo> {
  const trimmed = token.trim()
  if (!trimmed || trimmed.length > 256) throw new Error("Enter a Telegram BotFather token.")
  const bot = await telegramCall<TelegramUser>(trimmed, "getMe")
  if (!Number.isSafeInteger(bot.id) || !bot.username) throw new Error("Telegram getMe did not return a valid bot identity.")
  const webhook = await telegramCall<{ url?: string }>(trimmed, "getWebhookInfo")
  if (webhook.url) throw new Error("The token is valid, but a webhook is configured. Remove the webhook before using the local long-polling client.")
  return { id: bot.id, firstName: bot.first_name || "Telegram bot", username: bot.username }
}

async function readState(statePath: string): Promise<TelegramDiskState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as TelegramDiskState
    return {
      offset: Number.isSafeInteger(parsed.offset) && (parsed.offset || 0) >= 0 ? parsed.offset : 0,
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    }
  } catch { return { offset: 0, sessions: {} } }
}

async function persistState(value: TelegramRuntime): Promise<void> {
  await mkdir(join(value.installDirectory, "data", "api-vault"), { recursive: true })
  const temporary = value.statePath + "." + randomUUID() + ".tmp"
  await writeFile(temporary, JSON.stringify({ offset: value.offset, sessions: value.sessions }, null, 2), { encoding: "utf8", flag: "wx" })
  try { await rename(temporary, value.statePath) } catch (error) {
    const { rm } = await import("node:fs/promises")
    await rm(temporary, { force: true })
    throw error
  }
}

function isApproved(value: TelegramRuntime, userId: number, chatId: number): boolean {
  return value.status.approvedChats.some((item) => item.userId === userId && item.chatId === chatId)
}

async function sendText(value: TelegramRuntime, chatId: number, text: string, replyMarkup?: unknown): Promise<TelegramMessage | undefined> {
  try {
    return await telegramCall<TelegramMessage>(value.token, "sendMessage", {
      chat_id: chatId,
      text: text.slice(0, TELEGRAM_MAX_MESSAGE_CHARS),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      disable_web_page_preview: true,
    }, value.controller.signal)
  } catch (error) {
    if (!value.controller.signal.aborted) value.status.lastError = error instanceof Error ? error.message : String(error)
    return undefined
  }
}

async function sendLongText(value: TelegramRuntime, chatId: number, text: string): Promise<void> {
  const output = text || "(The agent returned an empty response.)"
  for (let index = 0; index < output.length; index += TELEGRAM_MAX_MESSAGE_CHARS) {
    await sendText(value, chatId, output.slice(index, index + TELEGRAM_MAX_MESSAGE_CHARS))
  }
}

async function editText(value: TelegramRuntime, chatId: number, messageId: number, text: string): Promise<void> {
  try {
    await telegramCall(value.token, "editMessageText", { chat_id: chatId, message_id: messageId, text: text.slice(0, TELEGRAM_MAX_MESSAGE_CHARS), disable_web_page_preview: true }, value.controller.signal)
  } catch { /* progress edits are best-effort; final messages carry the run result */ }
}

function sanitiseName(value: string): string {
  const base = basename(value).replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "")
  return base.slice(0, 90) || "attachment"
}

function inferExtension(name: string, mimeType: string | undefined): string {
  const extension = extname(name).toLowerCase()
  if (supportedDocumentExtensions.has(extension)) return extension
  const byMime: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "text/plain": ".txt", "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/json": ".json", "text/csv": ".csv",
  }
  const inferred = mimeType ? byMime[mimeType.toLowerCase()] : undefined
  if (inferred) return inferred
  throw new Error("That Telegram attachment type is not supported.")
}

async function downloadTelegramFile(value: TelegramRuntime, chatId: number, fileId: string, name: string, mimeType?: string, reportedSize?: number): Promise<ApiVaultAsset> {
  if (reportedSize && reportedSize > MAX_INCOMING_FILE_BYTES) throw new Error("Attachments are limited to 10 MiB each.")
  const file = await telegramCall<TelegramFile>(value.token, "getFile", { file_id: fileId }, value.controller.signal)
  if (!file.file_path) throw new Error("Telegram did not return a downloadable file path.")
  if (file.file_size && file.file_size > MAX_INCOMING_FILE_BYTES) throw new Error("Attachments are limited to 10 MiB each.")
  const extension = inferExtension(name || file.file_path, mimeType)
  const response = await fetch("https://api.telegram.org/file/bot" + value.token + "/" + file.file_path, {
    signal: signalFor(35_000, value.controller.signal),
  })
  if (!response.ok) throw new Error("Telegram attachment download failed with HTTP " + response.status + ".")
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_INCOMING_FILE_BYTES) throw new Error("Telegram attachment is empty or exceeds the 10 MiB limit.")
  const inbox = join(value.installDirectory, "data", "api-vault", "telegram-inbox")
  await mkdir(inbox, { recursive: true })
  const id = randomUUID()
  const savedPath = join(inbox, id + extension)
  await writeFile(savedPath, bytes, { flag: "wx" })
  const finalName = sanitiseName(name || id + extension)
  return {
    id,
    path: savedPath,
    name: finalName,
    kind: imageExtensions.has(extension) ? "image" : "document",
  }
}

async function readMessageAssets(value: TelegramRuntime, message: TelegramMessage): Promise<ApiVaultAsset[]> {
  const assets: ApiVaultAsset[] = []
  if (message.photo?.length) {
    const photo = [...message.photo].sort((a, b) => (b.file_size || 0) - (a.file_size || 0)).at(0)!
    assets.push(await downloadTelegramFile(value, message.chat.id, photo.file_id, "telegram-photo.jpg", "image/jpeg", photo.file_size))
  }
  if (message.document) {
    const doc = message.document
    assets.push(await downloadTelegramFile(value, message.chat.id, doc.file_id, doc.file_name || "telegram-attachment", doc.mime_type, doc.file_size))
  }
  return assets
}

async function answerCallback(value: TelegramRuntime, query: TelegramCallbackQuery, text: string): Promise<void> {
  try { await telegramCall(value.token, "answerCallbackQuery", { callback_query_id: query.id, text: text.slice(0, 180), show_alert: true }, value.controller.signal) } catch { /* button feedback is not a runtime dependency */ }
}

async function handleCallback(value: TelegramRuntime, query: TelegramCallbackQuery): Promise<void> {
  const data = query.data || ""
  const match = /^approval:([a-f0-9-]{36}):(approve|deny)$/.exec(data)
  const chatId = query.message?.chat.id
  if (!match || !chatId || query.message?.chat.type !== "private" || !isApproved(value, query.from.id, chatId)) {
    await answerCallback(value, query, "This approval is not authorized or has expired.")
    return
  }
  const pending = value.pendingApprovals.get(match[1])
  if (!pending || pending.userId !== query.from.id || pending.chatId !== chatId) {
    await answerCallback(value, query, "This approval has expired.")
    return
  }
  clearTimeout(pending.timer)
  value.pendingApprovals.delete(match[1])
  pending.resolve(match[2] === "approve")
  await answerCallback(value, query, match[2] === "approve" ? "Operation approved." : "Operation denied.")
}

async function requestToolApproval(value: TelegramRuntime, userId: number, chatId: number, name: string, args: Record<string, unknown>): Promise<boolean> {
  const requestId = randomUUID()
  const pathValue = typeof args.path === "string" ? args.path : "the requested target"
  const detail = name + " · " + pathValue + (args.overwrite === true ? " · replace existing content" : "")
  const promise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      value.pendingApprovals.delete(requestId)
      resolve(false)
    }, 60_000)
    value.pendingApprovals.set(requestId, { userId, chatId, resolve, timer })
  })
  const sent = await sendText(value, chatId, "Approval required (expires in 60 seconds):\n" + detail, {
    inline_keyboard: [[
      { text: "Approve", callback_data: "approval:" + requestId + ":approve" },
      { text: "Deny", callback_data: "approval:" + requestId + ":deny" },
    ]],
  })
  if (!sent) {
    const pending = value.pendingApprovals.get(requestId)
    if (pending) { clearTimeout(pending.timer); value.pendingApprovals.delete(requestId); pending.resolve(false) }
  }
  return promise
}

function sessionFor(value: TelegramRuntime, userId: number, chatId: number): TelegramSession {
  const key = peerKey(userId, chatId)
  if (!value.sessions[key]) value.sessions[key] = { executionMode: "agent" }
  return value.sessions[key]
}

async function sendArtifact(value: TelegramRuntime, chatId: number, file: string): Promise<void> {
  try {
    const metadata = await stat(file)
    if (!metadata.isFile() || metadata.size > MAX_OUTGOING_FILE_BYTES) {
      await sendText(value, chatId, "Artifact not attached because it is over the 20 MiB Telegram upload limit: " + basename(file))
      return
    }
    const bytes = await readFile(file)
    const form = new FormData()
    form.set("chat_id", String(chatId))
    form.set("document", new Blob([Uint8Array.from(bytes)]), sanitiseName(basename(file)))
    const response = await fetch("https://api.telegram.org/bot" + value.token + "/sendDocument", {
      method: "POST",
      body: form,
      signal: signalFor(60_000, value.controller.signal),
    })
    const payload = await response.json().catch(() => ({})) as TelegramEnvelope<unknown>
    if (!response.ok || !payload.ok) throw new Error("Telegram did not accept the artifact upload.")
  } catch (error) {
    if (!value.controller.signal.aborted) await sendText(value, chatId, "Could not attach artifact " + basename(file) + ": " + (error instanceof Error ? error.message : String(error)))
  }
}

async function runRemoteMessage(value: TelegramRuntime, message: TelegramMessage, userId: number, chatId: number, content: string): Promise<void> {
  const key = peerKey(userId, chatId)
  if (value.activeRuns.has(key)) {
    await sendText(value, chatId, "A run is already active here. Send /stop to cancel it.")
    return
  }
  const controller = new AbortController()
  value.activeRuns.set(key, controller)
  const progressMessage = await sendText(value, chatId, "Working…")
  let lastProgressEdit = 0
  try {
    const assets = await readMessageAssets(value, message)
    const settings = value.settings
    const provider = settings.activeProvider as ApiProvider
    const profile = settings.providers[provider]
    if (!profile || !profile.endpoint.trim() || !profile.model.trim()) throw new Error("Configure a Chat provider and model in desktop API Vault first.")
    const session = sessionFor(value, userId, chatId)
    const prompt = content.trim() || (assets.length ? "Please inspect the attached asset(s) and help with the request." : "")
    if (!prompt) throw new Error("Send a text prompt or a supported attachment.")
    const request = {
      runId: randomUUID(),
      provider,
      endpoint: profile.endpoint,
      apiKey: profile.apiKey,
      model: profile.model,
      imageModel: profile.imageModel,
      imageModelCatalog: settings.modelCatalogs?.[provider]?.image || [],
      imageAspectRatio: profile.imageAspectRatio || "auto",
      fallbackModel: provider === "9router" ? profile.fallbackModel : undefined,
      reasoning: profile.reasoning,
      outputKind: "text" as const,
      executionMode: session.executionMode,
      conversationMode: session.executionMode === "agent" || session.conversationId ? "continue" as const : "independent" as const,
      threadId: session.conversationId,
      systemInstruction: "",
      prompt,
      assets,
    }
    const control: ApiVaultRunControl = {
      signal: controller.signal,
      approveToolCall: (name, args) => requestToolApproval(value, userId, chatId, name, args),
    }
    const result = await runApiVault(value.installDirectory, request, (event) => {
      if (!progressMessage || !["tool-started", "tool-succeeded", "tool-failed"].includes(event.phase)) return
      const now = Date.now()
      if (now - lastProgressEdit < 1_200) return
      lastProgressEdit = now
      void editText(value, chatId, progressMessage.message_id, event.message)
    }, control)
    if (session.executionMode === "agent" && result.threadId) session.conversationId = result.threadId
    await persistState(value)
    const report = result.text + (result.files.length ? "\n\nArtifacts:\n" + result.files.map((file) => "- " + basename(file)).join("\n") : "")
    await sendLongText(value, chatId, report)
    for (const file of result.files.slice(0, 8)) await sendArtifact(value, chatId, file)
  } catch (error) {
    const messageText = controller.signal.aborted ? "Run stopped." : "Run failed: " + (error instanceof Error ? error.message : String(error))
    await sendText(value, chatId, messageText)
  } finally {
    value.activeRuns.delete(key)
  }
}

async function handleMessage(value: TelegramRuntime, message: TelegramMessage): Promise<void> {
  if (message.chat.type !== "private" || !message.from) return
  const userId = message.from.id
  const chatId = message.chat.id
  const textValue = (message.text || message.caption || "").trim()
  const key = peerKey(userId, chatId)
  const paired = isApproved(value, userId, chatId)

  if (!paired) {
    if (/^\/start(?:\s|$)/i.test(textValue)) {
      if (value.status.pairingUntil && Date.parse(value.status.pairingUntil) > Date.now()) {
        const candidate: ApiVaultTelegramCandidate = {
          userId, chatId,
          firstName: message.from.first_name || message.chat.first_name,
          lastName: message.from.last_name || message.chat.last_name,
          username: message.from.username || message.chat.username,
          receivedAt: new Date().toISOString(),
        }
        value.status.candidates = [...value.status.candidates.filter((item) => !(item.userId === userId && item.chatId === chatId)), candidate]
        await sendText(value, chatId, "Pairing request received. Approve this Telegram user and private chat in desktop API Vault. This message does not authorize access.")
      } else {
        await sendText(value, chatId, "Pairing is closed. Open the five-minute pairing window from desktop API Vault, then send /start again.")
      }
    }
    return
  }

  if (/^\/stop(?:\s|$)/i.test(textValue)) {
    const active = value.activeRuns.get(key)
    if (active) { active.abort(); await sendText(value, chatId, "Stop requested.") }
    else await sendText(value, chatId, "There is no active run to stop.")
    return
  }
  const mode = /^\/mode\s+(agent|prompt|independent)$/i.exec(textValue)
  if (mode) {
    sessionFor(value, userId, chatId).executionMode = mode[1].toLowerCase() === "agent" ? "agent" : "independent"
    await persistState(value)
    await sendText(value, chatId, "Execution mode set to " + sessionFor(value, userId, chatId).executionMode + ".")
    return
  }
  if (/^\/new(?:\s|$)/i.test(textValue)) {
    delete sessionFor(value, userId, chatId).conversationId
    await persistState(value)
    await sendText(value, chatId, "Started a fresh conversation context.")
    return
  }
  if (/^\/conversations(?:\s|$)/i.test(textValue)) {
    const conversations = await listApiVaultConversations(value.installDirectory)
    const body = conversations.length
      ? "Saved conversations:\n" + conversations.slice(0, 30).map((item) => item.id + " · " + item.title + " · " + item.turnCount + " turns").join("\n") + "\n\nUse /use <id> to continue one."
      : "There are no saved conversations yet. Switch to Agent mode and send a message to create one."
    await sendLongText(value, chatId, body)
    return
  }
  const useConversation = /^\/use\s+([a-zA-Z0-9_-]{1,128})$/i.exec(textValue)
  if (useConversation) {
    const conversations = await listApiVaultConversations(value.installDirectory)
    const chosen = conversations.find((item) => item.id === useConversation[1])
    if (!chosen) { await sendText(value, chatId, "That saved conversation was not found."); return }
    sessionFor(value, userId, chatId).conversationId = chosen.id
    await persistState(value)
    await sendText(value, chatId, "Using conversation " + chosen.id + " · " + chosen.title + ".")
    return
  }
  if (/^\/start(?:\s|$)/i.test(textValue)) {
    await sendText(value, chatId, "Connected to Kuntyy AutoPrompt. Use /mode agent or /mode prompt; /new starts fresh; /conversations lists saved chats; /stop cancels a run.")
    return
  }
  void runRemoteMessage(value, message, userId, chatId, textValue)
}

async function handleUpdate(value: TelegramRuntime, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(value, update.callback_query)
    return
  }
  if (update.message) await handleMessage(value, update.message)
}

async function pollingLoop(value: TelegramRuntime): Promise<void> {
  while (!value.controller.signal.aborted) {
    try {
      const updates = await telegramCall<TelegramUpdate[]>(value.token, "getUpdates", {
        offset: value.offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      }, value.controller.signal)
      for (const update of updates) {
        await handleUpdate(value, update).catch((error) => {
          if (!value.controller.signal.aborted) value.status.lastError = error instanceof Error ? error.message : String(error)
        })
        value.offset = Math.max(value.offset, update.update_id + 1)
        await persistState(value).catch((error) => {
          if (!value.controller.signal.aborted) value.status.lastError = "Unable to persist Telegram update offset: " + (error instanceof Error ? error.message : String(error))
        })
      }
    } catch (error) {
      if (value.controller.signal.aborted) break
      value.status.lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  value.status.running = false
}

export async function startApiVaultTelegram(installDirectory: string, settings: ApiVaultSettings): Promise<ApiVaultTelegramStatus> {
  const telegram = settings.telegram
  if (!telegram?.enabled || !telegram.botToken.trim()) throw new Error("Validate and enable a Telegram bot token before connecting.")
  if (runtime && runtime.token === telegram.botToken && runtime.controller.signal.aborted === false) {
    runtime.settings = settings
    runtime.status.approvedChats = telegram.approvedChats.map((item) => ({ ...item }))
    return safeStatus(runtime)
  }
  await stopApiVaultTelegram()
  const bot = await validateApiVaultTelegramBot(telegram.botToken)
  const statePath = join(installDirectory, "data", "api-vault", "telegram-state.json")
  const disk = await readState(statePath)
  const approvedChats = telegram.approvedChats || []
  const value: TelegramRuntime = {
    installDirectory,
    settings,
    token: telegram.botToken,
    controller: new AbortController(),
    bot,
    status: {
      running: true,
      bot,
      candidates: [],
      approvedChats: approvedChats.map((item) => ({ ...item })),
    },
    offset: disk.offset || 0,
    sessions: disk.sessions || {},
    statePath,
    activeRuns: new Map(),
    pendingApprovals: new Map(),
  }
  runtime = value
  value.pollPromise = pollingLoop(value)
  return safeStatus(value)
}

export function beginApiVaultTelegramPairing(): ApiVaultTelegramStatus {
  if (!runtime || runtime.controller.signal.aborted) throw new Error("Connect a validated Telegram bot first.")
  runtime.status.pairingUntil = new Date(Date.now() + 5 * 60_000).toISOString()
  runtime.status.candidates = []
  return safeStatus(runtime)
}

export function getApiVaultTelegramStatus(): ApiVaultTelegramStatus {
  if (!runtime) return { running: false, candidates: [], approvedChats: [] }
  if (runtime.status.pairingUntil && Date.parse(runtime.status.pairingUntil) <= Date.now()) {
    runtime.status.pairingUntil = undefined
    runtime.status.candidates = []
  }
  return safeStatus(runtime)
}

export function approveApiVaultTelegramCandidate(userId: number, chatId: number): ApiVaultTelegramStatus {
  if (!runtime) throw new Error("Connect a Telegram bot before approving a pairing request.")
  const candidate = runtime.status.candidates.find((item) => item.userId === userId && item.chatId === chatId)
  if (!candidate) throw new Error("The Telegram pairing candidate is missing or the pairing window has expired.")
  if (!runtime.status.pairingUntil || Date.parse(runtime.status.pairingUntil) <= Date.now()) throw new Error("The pairing window is closed.")
  if (!isApproved(runtime, userId, chatId)) runtime.status.approvedChats = [...runtime.status.approvedChats, {
    userId, chatId,
    firstName: candidate.firstName, lastName: candidate.lastName, username: candidate.username,
  }]
  runtime.status.candidates = runtime.status.candidates.filter((item) => !(item.userId === userId && item.chatId === chatId))
  return safeStatus(runtime)
}

export function updateApiVaultTelegramSettings(settings: ApiVaultSettings): ApiVaultTelegramStatus {
  if (!runtime) return { running: false, candidates: [], approvedChats: [] }
  if (!settings.telegram?.enabled || !settings.telegram.botToken) {
    void stopApiVaultTelegram()
    return { running: false, candidates: [], approvedChats: [] }
  }
  if (settings.telegram.botToken !== runtime.token) {
    throw new Error("Telegram bot token changed. Disconnect and reconnect to use the new token.")
  }
  runtime.settings = settings
  runtime.status.approvedChats = (settings.telegram.approvedChats || []).map((item) => ({ ...item }))
  return safeStatus(runtime)
}

export async function disconnectApiVaultTelegram(): Promise<ApiVaultTelegramStatus> {
  await stopApiVaultTelegram()
  return { running: false, candidates: [], approvedChats: [] }
}

export async function stopApiVaultTelegram(): Promise<void> {
  if (!runtime) return
  const value = runtime
  runtime = undefined
  value.controller.abort()
  for (const active of value.activeRuns.values()) active.abort()
  for (const pending of value.pendingApprovals.values()) {
    clearTimeout(pending.timer)
    pending.resolve(false)
  }
  value.pendingApprovals.clear()
  await value.pollPromise?.catch(() => undefined)
  value.status.running = false
}
