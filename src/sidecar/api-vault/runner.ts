import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { extname, isAbsolute, join, resolve } from "node:path"
import type { AgentTraceEntry, ApiVaultConversation, ApiVaultRequest, ApiVaultResponse } from "../../shared/api-vault.js"
import type { ApiProvider } from "../../shared/api-vault.js"
import { routedModel } from "../../shared/api-vault.js"
import { parseDocument } from "./documents.js"
import { createToolContext, executeFilesystemTool, FILESYSTEM_TOOLS } from "./filesystem.js"

type Message = { role: "system" | "user" | "assistant" | "tool"; content: unknown; tool_calls?: ToolCall[]; tool_call_id?: string; tool_name?: string }
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }
type OpenAiResponse = { id?: string; model?: string; choices?: Array<{ message?: { role?: string; content?: unknown; tool_calls?: ToolCall[] } }>; error?: { message?: string } }

const MAX_TOOL_ROUNDS = 8
const MAX_TOOL_CALLS = 16
const MAX_CONTEXT_CHARS = 300_000
const TOOL_TIMEOUT_MS = 30_000

function assistantText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((part) => {
    if (typeof part === "string") return [part]
    if (!part || typeof part !== "object") return []
    const value = part as Record<string, unknown>
    if (typeof value.text === "string") return [value.text]
    if (value.text && typeof value.text === "object" && typeof (value.text as Record<string, unknown>).value === "string") {
      return [(value.text as Record<string, unknown>).value as string]
    }
    if (typeof value.output_text === "string") return [value.output_text]
    return []
  }).join("")
}

async function withToolTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Filesystem tool exceeded 30 seconds.")), TOOL_TIMEOUT_MS) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function mimeType(pathValue: string): string {
  const extension = extname(pathValue).toLowerCase()
  if (extension === ".png") return "image/png"
  if (extension === ".webp") return "image/webp"
  if (extension === ".gif") return "image/gif"
  return "image/jpeg"
}

function endpointForChat(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "")
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`
}

function endpointForImages(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "")
  return trimmed.endsWith("/images/generations") ? trimmed : `${trimmed}/images/generations`
}

function imageExtension(mime: string): string {
  if (mime === "image/jpeg") return "jpg"
  if (mime === "image/webp") return "webp"
  if (mime === "image/gif") return "gif"
  return "png"
}

async function imageBytes(source: string): Promise<{ bytes: Buffer; mime: string }> {
  const data = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s)
  if (data) return { bytes: Buffer.from(data[2], "base64"), mime: data[1] }
  const url = new URL(source)
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Provider returned an unsupported image URL protocol: ${url.protocol}`)
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw await responseError(response)
  const bytes = Buffer.from(await response.arrayBuffer())
  return { bytes, mime: response.headers.get("content-type")?.split(";")[0] || "image/png" }
}

async function saveImages(outputDirectory: string, runId: string, sources: string[]): Promise<string[]> {
  if (!outputDirectory.trim()) throw new Error("Select an image result folder before running image output.")
  if (!isAbsolute(outputDirectory)) throw new Error("Image result folder must be an absolute path selected by the user.")
  if (sources.length > 8) throw new Error("Provider returned more than 8 images in one response.")
  await mkdir(outputDirectory, { recursive: true })
  const files: string[] = []
  for (const [index, source] of sources.entries()) {
    const image = await imageBytes(source)
    if (image.bytes.byteLength > 50 * 1024 * 1024) throw new Error("Provider image exceeds 50 MiB.")
    const file = join(outputDirectory, `api-vault-${runId}-${index + 1}.${imageExtension(image.mime)}`)
    await writeFile(file, image.bytes, { flag: "wx" })
    files.push(file)
  }
  return files
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.text()
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message || parsed.message
    return new Error(message || `Provider returned HTTP ${response.status}.`)
  } catch { return new Error(body || `Provider returned HTTP ${response.status}.`) }
}

export async function listApiVaultModels(provider: ApiProvider, endpoint: string, apiKey: string): Promise<string[]> {
  const base = endpoint.trim().replace(/\/+$/, "")
  const url = provider === "gemini" ? `${base}/models?key=${encodeURIComponent(apiKey)}` : `${base}/models`
  const response = await fetch(url, {
    headers: provider === "gemini" ? undefined : { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw await responseError(response)
  const raw = await response.json() as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
  const values = provider === "gemini"
    ? (raw.models || []).flatMap((item) => item.name ? [item.name.replace(/^models\//, "")] : [])
    : (raw.data || []).flatMap((item) => item.id ? [item.id] : [])
  return [...new Set(values)].sort((left, right) => left.localeCompare(right)).slice(0, 500)
}

async function callOpenAi(request: ApiVaultRequest, model: string, messages: Message[], tools: unknown[]): Promise<OpenAiResponse> {
  const providerMessages = messages.map(({ role, content, tool_calls, tool_call_id }) => ({
    role, content,
    ...(tool_calls ? { tool_calls } : {}),
    ...(tool_call_id ? { tool_call_id } : {}),
  }))
  const body: Record<string, unknown> = { model, messages: providerMessages, stream: false }
  if (tools.length) { body.tools = tools; body.tool_choice = "auto" }
  if (request.provider !== "9router" && request.reasoning !== "default") body.reasoning_effort = request.reasoning
  const response = await fetch(endpointForChat(request.endpoint), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw await responseError(response)
  const parsed = await response.json() as OpenAiResponse
  if (parsed.error) throw new Error(parsed.error.message || "Provider returned an error.")
  if (!parsed.choices?.[0]?.message) throw new Error("Provider response did not contain a message.")
  return parsed
}

function geminiContents(messages: Message[]): Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> {
  return messages.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "tool") {
      return {
        role: "user" as const,
        parts: [{ functionResponse: { name: message.tool_name || "unknown_tool", response: { output: message.content } } }],
      }
    }
    const parts = geminiParts(message.content)
    for (const call of message.tool_calls || []) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown> } catch { /* provider arguments are validated before execution */ }
      parts.push({ functionCall: { name: call.function.name, args } })
    }
    return { role: message.role === "assistant" ? "model" as const : "user" as const, parts }
  })
}

function geminiParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ text: content }]
  if (!Array.isArray(content)) return [{ text: String(content ?? "") }]
  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (!part || typeof part !== "object") return []
    const value = part as Record<string, unknown>
    if (value.type === "text") return [{ text: value.text }]
    const image = value.image_url as { url?: string } | undefined
    if (value.type === "image_url" && image?.url?.startsWith("data:")) {
      const match = image.url.match(/^data:([^;,]+);base64,(.+)$/s)
      if (match) return [{ inlineData: { mimeType: match[1], data: match[2] } }]
    }
    return []
  })
}

async function callGemini(request: ApiVaultRequest, messages: Message[], tools: unknown[]): Promise<OpenAiResponse> {
  const base = request.endpoint.trim().replace(/\/+$/, "")
  const url = `${base}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(request.apiKey)}`
  const system = messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n")
  const contents = geminiContents(messages)
  const body: Record<string, unknown> = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (tools.length) body.tools = [{ functionDeclarations: tools.map((tool) => (tool as { function: unknown }).function) }]
  if (request.reasoning !== "default") body.generationConfig = { thinkingConfig: { thinkingLevel: request.reasoning.toUpperCase() } }
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw await responseError(response)
  const raw = await response.json() as { modelVersion?: string; responseId?: string; candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }> } }> }
  const parts = raw.candidates?.[0]?.content?.parts || []
  const toolCalls: ToolCall[] = parts.filter((part) => part.functionCall).map((part) => ({ id: randomUUID(), type: "function", function: { name: part.functionCall!.name, arguments: JSON.stringify(part.functionCall!.args || {}) } }))
  return { id: raw.responseId, model: raw.modelVersion || request.model, choices: [{ message: { role: "assistant", content: parts.map((part) => part.text || "").join(""), tool_calls: toolCalls.length ? toolCalls : undefined } }] }
}

async function runImageRequest(request: ApiVaultRequest, model: string): Promise<{ model: string; responseId?: string; text: string; sources: string[] }> {
  if (request.executionMode === "agent") throw new Error("Image output is available in Prompt mode; Agent mode uses Text / JSON output.")
  if (request.assets.some((asset) => asset.kind === "image")) throw new Error("The standard image-generation route does not support reference-image assets. Remove image assets or use Text / JSON with a vision model.")
  let prompt = request.systemInstruction.trim() ? `${request.systemInstruction.trim()}\n\n${request.prompt}` : request.prompt
  for (const asset of request.assets) {
    const parsed = await parseDocument(asset.path)
    prompt += `\n\n<document name="${asset.name}">\n${parsed}\n</document>`
  }
  if (request.provider === "gemini") {
    const base = request.endpoint.trim().replace(/\/+$/, "")
    const url = `${base}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(request.apiKey)}`
    const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw await responseError(response)
    const raw = await response.json() as { modelVersion?: string; responseId?: string; candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> } }> }
    const parts = raw.candidates?.[0]?.content?.parts || []
    const sources = parts.flatMap((part) => part.inlineData?.data ? [`data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}`] : [])
    if (!sources.length) throw new Error("Provider response did not contain an image.")
    return { model: raw.modelVersion || request.model, responseId: raw.responseId, text: parts.map((part) => part.text || "").join(""), sources }
  }
  const response = await fetch(endpointForImages(request.endpoint), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
    body: JSON.stringify({ model, prompt, n: 1 }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw await responseError(response)
  const raw = await response.json() as { id?: string; model?: string; data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>; error?: { message?: string } }
  if (raw.error) throw new Error(raw.error.message || "Provider returned an image-generation error.")
  const sources = (raw.data || []).flatMap((item) => item.b64_json ? [`data:image/png;base64,${item.b64_json}`] : item.url ? [item.url] : [])
  if (!sources.length) throw new Error("Provider response did not contain an image URL or base64 image.")
  return { model: raw.model || model, responseId: raw.id, text: raw.data?.[0]?.revised_prompt || "Image generated.", sources }
}

async function buildUserContent(request: ApiVaultRequest): Promise<Array<Record<string, unknown>>> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: request.prompt }]
  let contextChars = request.prompt.length
  for (const asset of request.assets) {
    if (asset.kind === "image") {
      const data = (await readFile(asset.path)).toString("base64")
      content.push({ type: "image_url", image_url: { url: `data:${mimeType(asset.path)};base64,${data}`, detail: "high" } })
      continue
    }
    const parsed = await parseDocument(asset.path)
    contextChars += parsed.length
    if (contextChars > MAX_CONTEXT_CHARS) throw new Error("Parsed document context exceeds 300,000 characters.")
    content.push({ type: "text", text: `<document name="${asset.name}">\n${parsed}\n</document>` })
  }
  return content
}

function validThreadId(value: string | undefined): value is string {
  return Boolean(value && /^[a-zA-Z0-9_-]{1,128}$/.test(value))
}

async function loadThread(dataDirectory: string, request: ApiVaultRequest): Promise<{ id: string; messages: Message[] }> {
  const id = request.conversationMode === "continue" && validThreadId(request.threadId) ? request.threadId : randomUUID()
  if (request.conversationMode !== "continue") return { id, messages: [] }
  const pathValue = join(dataDirectory, "conversations", `${id}.json`)
  try {
    const parsed = JSON.parse(await readFile(pathValue, "utf8")) as { messages?: Message[] }
    return { id, messages: Array.isArray(parsed.messages) ? parsed.messages : [] }
  } catch { return { id, messages: [] } }
}

async function saveThread(dataDirectory: string, id: string, messages: Message[]): Promise<void> {
  const directory = join(dataDirectory, "conversations")
  await mkdir(directory, { recursive: true })
  const firstUser = messages.find((message) => message.role === "user")
  const title = assistantText(firstUser?.content).replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled conversation"
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ id, title, updatedAt: new Date().toISOString(), messages }, null, 2), "utf8")
}

function messagesForExecutionMode(messages: Message[], executionMode: ApiVaultRequest["executionMode"]): Message[] {
  if (executionMode === "agent") return messages
  return messages.flatMap((message) => {
    if (message.role === "tool") return []
    if (message.role !== "assistant") return [message]
    const content = assistantText(message.content)
    return content.trim() ? [{ role: "assistant" as const, content }] : []
  })
}

export async function listApiVaultConversations(installDirectory: string): Promise<ApiVaultConversation[]> {
  const directory = resolve(installDirectory, "data", "api-vault", "conversations")
  let entries: string[]
  try { entries = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const conversations = await Promise.all(entries.filter((entry) => /^[a-zA-Z0-9_-]{1,128}\.json$/.test(entry)).map(async (entry) => {
    try {
      const parsed = JSON.parse(await readFile(join(directory, entry), "utf8")) as { id?: string; title?: string; updatedAt?: string; messages?: Message[] }
      if (!validThreadId(parsed.id) || !Array.isArray(parsed.messages)) return null
      return {
        id: parsed.id,
        title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 80) : "Untitled conversation",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        turnCount: parsed.messages.filter((message) => message.role === "user").length,
      } satisfies ApiVaultConversation
    } catch { return null }
  }))
  return conversations.filter((item): item is ApiVaultConversation => item !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function deleteApiVaultConversation(installDirectory: string, id: string): Promise<void> {
  if (!validThreadId(id)) throw new Error("Conversation id is invalid.")
  const file = resolve(installDirectory, "data", "api-vault", "conversations", `${id}.json`)
  await rm(file, { force: true })
}

export async function runApiVault(installDirectory: string, request: ApiVaultRequest): Promise<ApiVaultResponse> {
  if (!request.endpoint.trim() || !request.model.trim() || !request.prompt.trim()) throw new Error("Endpoint, model, and prompt are required.")
  const runId = randomUUID()
  const trace: AgentTraceEntry[] = []
  const files: string[] = []
  let model = routedModel(request.model, request.provider, request.reasoning)
  if (request.outputKind === "image") {
    let generated: Awaited<ReturnType<typeof runImageRequest>>
    try {
      generated = await runImageRequest(request, model)
    } catch (error) {
      if (request.provider !== "9router" || !request.fallbackModel?.trim() || model === routedModel(request.fallbackModel, request.provider, request.reasoning)) throw error
      model = routedModel(request.fallbackModel, request.provider, request.reasoning)
      generated = await runImageRequest(request, model)
    }
    const generatedFiles = await saveImages(request.outputDirectory || "", runId, generated.sources)
    return { runId, text: generated.text, responseId: generated.responseId, model: generated.model, files: generatedFiles, trace: [{ type: "provider", label: generated.model, detail: `Saved ${generatedFiles.length} image(s)` }] }
  }
  const dataDirectory = resolve(installDirectory, "data", "api-vault")
  const thread = await loadThread(dataDirectory, request)
  const messages: Message[] = messagesForExecutionMode(
    thread.messages.filter((message) => message.role !== "system"),
    request.executionMode,
  )
  if (request.systemInstruction.trim()) messages.unshift({ role: "system", content: request.systemInstruction.trim() })
  messages.push({ role: "user", content: await buildUserContent(request) })
  const context = createToolContext(installDirectory, request.prompt, request.assets.map((asset) => asset.path))
  await mkdir(context.workspace, { recursive: true })
  const tools = request.executionMode === "agent"
    ? FILESYSTEM_TOOLS.filter((tool) => context.allowWrite || !["create_directory", "write_text_file", "write_json_file"].includes(tool.function.name))
    : []
  let responseId: string | undefined
  let finalText = ""
  let calls = 0

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    trace.push({ type: "provider", label: model, detail: `Request ${round + 1}` })
    let response: OpenAiResponse
    try {
      response = request.provider === "gemini" ? await callGemini(request, messages, tools) : await callOpenAi(request, model, messages, tools)
    } catch (error) {
      if (request.provider !== "9router" || !request.fallbackModel?.trim() || model === routedModel(request.fallbackModel, request.provider, request.reasoning)) throw error
      model = routedModel(request.fallbackModel, request.provider, request.reasoning)
      trace.push({ type: "provider", label: model, detail: `Fallback after: ${error instanceof Error ? error.message : String(error)}` })
      response = await callOpenAi(request, model, messages, tools)
    }
    responseId = response.id
    const message = response.choices![0].message!
    const toolCalls = message.tool_calls || []
    messages.push({ role: "assistant", content: message.content || "", tool_calls: toolCalls.length ? toolCalls : undefined })
    if (!toolCalls.length) { finalText = assistantText(message.content); break }
    if (request.executionMode !== "agent") throw new Error("The provider requested an Agent tool, but Execution mode is Prompt. Switch to Agent and run again.")
    if (round === MAX_TOOL_ROUNDS) throw new Error(`Agent exceeded ${MAX_TOOL_ROUNDS} tool rounds.`)
    for (const call of toolCalls) {
      calls += 1
      if (calls > MAX_TOOL_CALLS) throw new Error(`Agent exceeded ${MAX_TOOL_CALLS} tool calls.`)
      let args: Record<string, unknown>
      try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown> } catch { throw new Error(`Tool ${call.function.name} returned invalid JSON arguments.`) }
      trace.push({ type: "tool", label: call.function.name, detail: typeof args.path === "string" ? args.path : "" })
      try {
        const result = await withToolTimeout(executeFilesystemTool(context, call.function.name, args))
        if (result.file) files.push(result.file)
        messages.push({ role: "tool", tool_call_id: call.id, tool_name: call.function.name, content: result.content })
        trace.push({ type: "result", label: call.function.name, detail: result.content.slice(0, 500) })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        messages.push({ role: "tool", tool_call_id: call.id, tool_name: call.function.name, content: JSON.stringify({ error: detail }) })
        trace.push({ type: "result", label: call.function.name, detail })
      }
    }
  }
  if (!finalText.trim()) throw new Error("Provider returned an empty final response.")
  if (request.conversationMode !== "independent") await saveThread(dataDirectory, thread.id, messages)
  return { runId, text: finalText, responseId, model, threadId: request.conversationMode === "independent" ? undefined : thread.id, files, trace }
}
