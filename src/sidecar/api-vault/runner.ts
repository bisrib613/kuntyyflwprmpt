import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { AgentTraceEntry, ApiModelCatalogItem, ApiVaultConversation, ApiVaultProgressEvent, ApiVaultRequest, ApiVaultResponse } from "../../shared/api-vault.js"
import type { ApiProvider } from "../../shared/api-vault.js"
import { routedModel } from "../../shared/api-vault.js"
import { parseDocument } from "./documents.js"
import { createToolContext, executeFilesystemTool, FILESYSTEM_TOOLS } from "./filesystem.js"
import { fetchWebResource, validateWebFetchUrl, type WebFetchFormat } from "./web-fetch.js"

type Message = { role: "system" | "user" | "assistant" | "tool"; content: unknown; tool_calls?: ToolCall[]; tool_call_id?: string; tool_name?: string }
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }
type OpenAiResponse = { id?: string; model?: string; choices?: Array<{ message?: { role?: string; content?: unknown; tool_calls?: ToolCall[] } }>; error?: { message?: string } }

const MAX_TOOL_ROUNDS = 8
const MAX_TOOL_CALLS = 16
const MAX_CONTEXT_CHARS = 300_000
const TOOL_TIMEOUT_MS = 30_000
const RUNTIME_INSTRUCTION = `You are the general-purpose primary agent inside Kuntyy AutoPrompt. This runtime instruction is a durable behavior contract, not a specialist role.
Understand and complete the user's actual goal. Use the registered tools when they materially help complete or verify the task. Continue across multiple tool cycles when needed; do not abbreviate a substantial deliverable merely to fit one response. Inspect relevant existing files and context before destructive or conflicting changes.
Let the user's instructions determine deliverable count, filenames, formats, separators, and directory structure. Preserve explicit prompt text, model names, paths, image prompts, aspect ratios, and parameters; infer only missing values. Treat tool results as observations and recover from truthful errors where possible. Never claim that a file, image, fetch, or operation succeeded without a successful tool result.
When files are requested, keep substantial content in real artifacts and return a concise report grounded in actual tool results. Direct responses are also valid; do not create unnecessary plans or files. Use dedicated filesystem tools rather than shell or PowerShell. Do not invent domain-specific workflows, parse user prose as runtime control, synthesize progress or completion claims, or expose credentials, hidden reasoning, raw protocol payloads, or internal provider traces.`

function validRunId(value: string | undefined): value is string {
  return Boolean(value && /^[a-zA-Z0-9_-]{1,128}$/.test(value))
}

function toolProgress(name: string, args: Record<string, unknown>, completed: boolean, file?: string): string {
  const requested = typeof args.path === "string" && args.path.trim() ? args.path : "the workspace"
  const target = file || requested
  if (["write_file", "write_text_file", "write_json_file"].includes(name)) return completed ? `Saved ${target}.` : `Writing ${requested}…`
  if (name === "edit_file") return completed ? `Edited ${target}.` : `Editing ${requested}…`
  if (name === "web_fetch") return completed ? `Fetched ${typeof args.url === "string" ? args.url : requested}.` : `Fetching ${typeof args.url === "string" ? args.url : requested}…`
  if (name === "image_generate") return completed ? `Generated image${file ? ` · ${file}` : ""}.` : "Generating image…"
  if (name === "create_directory") return completed ? `Created ${target}.` : `Creating ${requested}…`
  if (name === "read_file") return completed ? `Read ${target}.` : `Reading ${requested}…`
  if (name === "list_directory") return completed ? `Inspected ${target}.` : `Inspecting ${requested}…`
  if (name === "get_file_metadata") return completed ? `Inspected ${target}.` : `Inspecting ${requested}…`
  return completed ? `${name} completed.` : `Running ${name}…`
}

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

function conversationTitle(content: unknown): string {
  return assistantText(content)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Untitled conversation"
}

async function withToolTimeout<T>(promise: Promise<T>, timeoutMs = TOOL_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let abortHandler: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`Tool execution exceeded ${Math.floor(timeoutMs / 1000)} seconds.`)), timeoutMs) }),
      ...(signal ? [new Promise<T>((_, reject) => {
        abortHandler = () => reject(new Error("Run was cancelled."))
        if (signal.aborted) abortHandler()
        else signal.addEventListener("abort", abortHandler, { once: true })
      })] : []),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler)
  }
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs)
}

export type ApiVaultRunControl = {
  signal?: AbortSignal
  approveToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
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

function detectedImageMime(bytes: Buffer, declaredMime = ""): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp"
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif"
  throw new Error(`Provider bytes do not match a supported image signature (declared ${declaredMime || "unknown"}). A file extension will not be inferred from a mismatched content type.`)
}

function imageExtension(mime: string): string {
  if (mime === "image/jpeg") return "jpg"
  if (mime === "image/webp") return "webp"
  if (mime === "image/gif") return "gif"
  if (mime === "image/png") return "png"
  throw new Error(`Unsupported image media type: ${mime}`)
}

async function imageBytes(source: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
  const data = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s)
  if (data) { const bytes = Buffer.from(data[2], "base64"); return { bytes, mime: detectedImageMime(bytes, data[1]) } }
  const url = new URL(source)
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Provider returned an unsupported image URL protocol: ${url.protocol}`)
  const response = await fetch(url, { signal: requestSignal(120_000, signal) })
  if (!response.ok) throw await responseError(response)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > 50 * 1024 * 1024) throw new Error("Provider image exceeds 50 MiB.")
  return { bytes, mime: detectedImageMime(bytes, response.headers.get("content-type")?.split(";")[0] || "") }
}

async function saveImages(outputDirectory: string, runId: string, sources: string[], signal?: AbortSignal): Promise<string[]> {
  if (!outputDirectory.trim()) throw new Error("Select an image result folder before running image output.")
  if (!isAbsolute(outputDirectory)) throw new Error("Image result folder must be an absolute path selected by the user.")
  if (sources.length > 8) throw new Error("Provider returned more than 8 images in one response.")
  await mkdir(outputDirectory, { recursive: true })
  const files: string[] = []
  for (const [index, source] of sources.entries()) {
    const image = await imageBytes(source, signal)
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


export type ApiVaultModelCatalogItem = ApiModelCatalogItem

export async function listApiVaultModelCatalog(
  provider: ApiProvider, endpoint: string, apiKey: string, outputType: "text" | "image" = "text",
): Promise<ApiVaultModelCatalogItem[]> {
  const base = endpoint.trim().replace(/\/+$/, "")
  const suffix = provider === "gemini"
    ? (outputType === "image" ? null : `/models?key=${encodeURIComponent(apiKey)}`)
    : outputType === "image" ? "/models/image" : "/models"
  if (!suffix) return []
  const url = `${base}${suffix}`
  const response = await fetch(url, {
    headers: provider === "gemini" ? undefined : { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw await responseError(response)
  const raw = await response.json() as { data?: Array<{ id?: string; owned_by?: string }>; models?: Array<{ name?: string; displayName?: string }> }
  const values: ApiVaultModelCatalogItem[] = provider === "gemini"
    ? (raw.models || []).flatMap((item) => item.name ? [{ id: item.name.replace(/^models\//, ""), outputType }] : [])
    : (raw.data || []).flatMap((item) => item.id ? [{ id: item.id, owned_by: item.owned_by, outputType }] : [])
  const distinct = [...new Map(values.map((item) => [item.id, item])).values()]
    .sort((left, right) => left.id.localeCompare(right.id)).slice(0, 500)

  // 9Router exposes capability metadata separately. Treat missing/unknown values as unknown;
  // do not infer request compatibility from a model's display name.
  if (provider !== "9router") return distinct
  const enriched: ApiVaultModelCatalogItem[] = []
  for (let index = 0; index < distinct.length; index += 8) {
    const batch = distinct.slice(index, index + 8)
    const results = await Promise.all(batch.map(async (item) => {
      try {
        const infoUrl = `${base}/models/info?id=${encodeURIComponent(item.id)}`
        const infoResponse = await fetch(infoUrl, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) })
        if (!infoResponse.ok) return item
        const envelope = await infoResponse.json() as Record<string, unknown>
        const info = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown>
          : envelope.model && typeof envelope.model === "object" ? envelope.model as Record<string, unknown> : envelope
        const rawCaps = info.capabilities && typeof info.capabilities === "object" ? info.capabilities as Record<string, unknown> : {}
        const parameterSource = info.supported_parameters ?? info.supportedParameters ?? info.parameters
        const supportedParameters = Array.isArray(parameterSource)
          ? parameterSource.filter((value): value is string => typeof value === "string")
          : parameterSource && typeof parameterSource === "object"
            ? Object.keys(parameterSource as Record<string, unknown>)
            : []
        const normalize = (...keys: string[]): boolean | "unknown" => {
          for (const key of keys) {
            const value = rawCaps[key] ?? info[key]
            if (typeof value === "boolean") return value
          }
          return "unknown"
        }
        return {
          ...item,
          owned_by: item.owned_by || (typeof info.owned_by === "string" ? info.owned_by : undefined),
          supportedParameters,
          capabilities: {
            textInput: normalize("textInput", "text_input", "supports_text_input"),
            imageInput: normalize("imageInput", "image_input", "supports_image_input", "vision"),
            imageGeneration: normalize("imageGeneration", "image_generation", "supports_image_generation"),
            toolCalling: normalize("toolCalling", "tool_calling", "supports_tool_calling"),
            structuredOutput: normalize("structuredOutput", "structured_output", "supports_structured_output"),
          },
        }
      } catch {
        return item
      }
    }))
    enriched.push(...results)
  }
  return enriched
}

export async function listApiVaultModels(provider: ApiProvider, endpoint: string, apiKey: string): Promise<string[]> {
  return (await listApiVaultModelCatalog(provider, endpoint, apiKey, "text")).map((item) => item.id)
}

type TextDeltaCallback = (delta: string) => void

function contentDeltaText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return []
    const item = part as Record<string, unknown>
    return typeof item.text === "string" ? [item.text] : []
  }).join("")
}

async function readOpenAiStream(response: Response, modelFallback: string, onTextDelta?: TextDeltaCallback): Promise<OpenAiResponse> {
  if (!response.body) throw new Error("Provider enabled streaming but did not return a response stream.")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let id: string | undefined
  let model = modelFallback
  let content = ""
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
  const consumeLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) return
    const data = trimmed.slice(5).trim()
    if (!data || data === "[DONE]") return
    const payload = JSON.parse(data) as {
      id?: string; model?: string; error?: { message?: string }
      choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>
    }
    if (payload.error) throw new Error(payload.error.message || "Provider returned a streaming error.")
    if (payload.id) id = payload.id
    if (payload.model) model = payload.model
    const delta = payload.choices?.[0]?.delta
    if (!delta) return
    const text = contentDeltaText(delta.content)
    if (text) { content += text; onTextDelta?.(text) }
    for (const call of delta.tool_calls || []) {
      const index = Number.isInteger(call.index) ? call.index! : toolCalls.size
      const previous = toolCalls.get(index) || { id: randomUUID(), name: "", arguments: "" }
      toolCalls.set(index, {
        id: call.id || previous.id,
        name: previous.name + (call.function?.name || ""),
        arguments: previous.arguments + (call.function?.arguments || ""),
      })
    }
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() || ""
    for (const line of lines) consumeLine(line.replace(/\r$/, ""))
  }
  buffer += decoder.decode()
  if (buffer.trim()) consumeLine(buffer)
  const calls: ToolCall[] = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments || "{}" },
  }))
  return { id, model, choices: [{ message: { role: "assistant", content, tool_calls: calls.length ? calls : undefined } }] }
}

async function callOpenAi(request: ApiVaultRequest, model: string, messages: Message[], tools: unknown[], onTextDelta?: TextDeltaCallback, signal?: AbortSignal): Promise<OpenAiResponse> {
  const providerMessages = messages.map(({ role, content, tool_calls, tool_call_id }) => ({
    role, content,
    ...(tool_calls ? { tool_calls } : {}),
    ...(tool_call_id ? { tool_call_id } : {}),
  }))
  const body: Record<string, unknown> = { model, messages: providerMessages, stream: true }
  if (tools.length) { body.tools = tools; body.tool_choice = "auto" }
  if (request.provider !== "9router" && request.reasoning !== "default") body.reasoning_effort = request.reasoning
  const response = await fetch(endpointForChat(request.endpoint), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
    body: JSON.stringify(body),
    signal: requestSignal(120_000, signal),
  })
  if (!response.ok) throw await responseError(response)
  if ((response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream")) {
    return readOpenAiStream(response, model, onTextDelta)
  }
  // Compatible gateways that do not stream still work; render their real completed text once received.
  const parsed = await response.json() as OpenAiResponse
  if (parsed.error) throw new Error(parsed.error.message || "Provider returned an error.")
  const message = parsed.choices?.[0]?.message
  if (!message) throw new Error("Provider response did not contain a message.")
  const fallbackText = assistantText(message.content)
  if (fallbackText) onTextDelta?.(fallbackText)
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

async function callGemini(request: ApiVaultRequest, messages: Message[], tools: unknown[], onTextDelta?: TextDeltaCallback, signal?: AbortSignal): Promise<OpenAiResponse> {
  const base = request.endpoint.trim().replace(/\/+$/, "")
  const url = `${base}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(request.apiKey)}`
  const system = messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n")
  const contents = geminiContents(messages)
  const body: Record<string, unknown> = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (tools.length) body.tools = [{ functionDeclarations: tools.map((tool) => (tool as { function: unknown }).function) }]
  if (request.reasoning !== "default") body.generationConfig = { thinkingConfig: { thinkingLevel: request.reasoning.toUpperCase() } }
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: requestSignal(120_000, signal) })
  if (!response.ok) throw await responseError(response)
  if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream")) {
    const raw = await response.json() as { modelVersion?: string; responseId?: string; candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }> } }> }
    const parts = raw.candidates?.[0]?.content?.parts || []
    const text = parts.map((part) => part.text || "").join("")
    if (text) onTextDelta?.(text)
    const toolCalls: ToolCall[] = parts.filter((part) => part.functionCall).map((part) => ({ id: randomUUID(), type: "function", function: { name: part.functionCall!.name, arguments: JSON.stringify(part.functionCall!.args || {}) } }))
    return { id: raw.responseId, model: raw.modelVersion || request.model, choices: [{ message: { role: "assistant", content: text, tool_calls: toolCalls.length ? toolCalls : undefined } }] }
  }
  if (!response.body) throw new Error("Gemini enabled streaming but returned no response stream.")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let responseId: string | undefined
  let modelVersion = request.model
  let text = ""
  const calls: ToolCall[] = []
  const consumeLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) return
    const data = trimmed.slice(5).trim()
    if (!data) return
    const chunk = JSON.parse(data) as { modelVersion?: string; responseId?: string; candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }> } }> }
    if (chunk.responseId) responseId = chunk.responseId
    if (chunk.modelVersion) modelVersion = chunk.modelVersion
    const parts = chunk.candidates?.[0]?.content?.parts || []
    for (const part of parts) {
      if (part.text) { text += part.text; onTextDelta?.(part.text) }
      if (part.functionCall) calls.push({ id: randomUUID(), type: "function", function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } })
    }
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() || ""
    for (const line of lines) consumeLine(line.replace(/\r$/, ""))
  }
  buffer += decoder.decode()
  if (buffer.trim()) consumeLine(buffer)
  return { id: responseId, model: modelVersion, choices: [{ message: { role: "assistant", content: text, tool_calls: calls.length ? calls : undefined } }] }
}

async function runImageRequest(request: ApiVaultRequest, model: string, signal?: AbortSignal): Promise<{ model: string; responseId?: string; text: string; sources: string[] }> {
  if (request.outputKind === "image" && request.executionMode === "agent") throw new Error("Direct Image is a separate operation and cannot run as an Agent-mode request.")
  if (request.assets.length) throw new Error("Direct Image does not accept Chat attachments. Remove assets and submit the image prompt directly.")
  const prompt = request.prompt
  const ratio = request.imageAspectRatio || "auto"
  const imageMetadata = request.imageModelCatalog?.find((item) => item.id === model)
  if (request.provider === "gemini") {
    const base = request.endpoint.trim().replace(/\/+$/, "")
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(request.apiKey)}`
    const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] }
    if (ratio !== "auto") generationConfig.imageConfig = { aspectRatio: ratio }
    const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig }
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: requestSignal(120_000, signal) })
    if (!response.ok) throw await responseError(response)
    const raw = await response.json() as { modelVersion?: string; responseId?: string; candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> } }> }
    const parts = raw.candidates?.[0]?.content?.parts || []
    const sources = parts.flatMap((part) => part.inlineData?.data ? [`data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}`] : [])
    if (!sources.length) throw new Error("Provider response did not contain an image.")
    return { model: raw.modelVersion || request.model, responseId: raw.responseId, text: parts.map((part) => part.text || "").join(""), sources }
  }
  const body: Record<string, unknown> = { model, prompt, n: 1 }
  const antigravitySizes: Record<string, string> = { "1:1": "1024x1024", "9:16": "1024x1792", "16:9": "1792x1024", "2:3": "1024x1536", "3:2": "1536x1024" }
  const gptImageSizes: Record<string, string> = { "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024" }
  if (ratio !== "auto") {
    const parameterSet = imageMetadata?.supportedParameters || []
    const antigravity = request.provider === "9router" && /antigravity/i.test(model)
    const gptImage = request.provider === "openai" && /^gpt-image/i.test(model)
    if (antigravity) {
      body.size = antigravitySizes[ratio]
    } else if (gptImage && gptImageSizes[ratio]) {
      body.size = gptImageSizes[ratio]
    } else if (parameterSet.includes("aspect_ratio")) {
      body.aspect_ratio = ratio
    } else if (parameterSet.includes("aspectRatio")) {
      body.aspectRatio = ratio
    } else if (parameterSet.includes("size") && gptImageSizes[ratio]) {
      body.size = gptImageSizes[ratio]
    } else {
      throw new Error(`The selected Image model does not declare a supported aspect-ratio parameter for ${ratio}. Choose Auto or select a model with a compatible image adapter.`)
    }
  }
  const response = await fetch(endpointForImages(request.endpoint), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
    body: JSON.stringify(body),
    signal: requestSignal(120_000, signal),
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

type AgentArtifactState = {
  id: string
  path: string
  kind: "file"
  operation: "created" | "modified"
  status: "working" | "ready" | "error"
  bytes: number
  revision: number
  updatedAt: string
}

async function persistRunState(
  dataDirectory: string,
  runId: string,
  statusValue: "running" | "completed" | "failed",
  currentStep: string,
  iteration: number,
  artifacts: AgentArtifactState[],
): Promise<void> {
  const directory = join(dataDirectory, "runs")
  await mkdir(directory, { recursive: true })
  const destination = join(directory, runId + ".json")
  const temporary = join(directory, "." + runId + "." + randomUUID() + ".tmp")
  const payload = {
    runId,
    status: statusValue,
    currentStep,
    iteration,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      status: statusValue === "completed" ? "ready" as const : statusValue === "failed" ? "error" as const : artifact.status,
    })),
    updatedAt: new Date().toISOString(),
  }
  await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: "utf8", flag: "wx" })
  try { await rename(temporary, destination) } catch (error) { await rm(temporary, { force: true }); throw error }
}

async function observeArtifact(installDirectory: string, file: string, operation: "created" | "modified", existing?: AgentArtifactState): Promise<AgentArtifactState> {
  const metadata = await stat(file)
  const relativePath = relative(installDirectory, file)
  const pathValue = !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : file
  return {
    id: existing?.id || randomUUID(),
    path: pathValue,
    kind: "file",
    operation: existing ? (existing.operation === "created" ? "created" : operation) : operation,
    status: "working",
    bytes: metadata.size,
    revision: (existing?.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
  }
}

function requiresTelegramApproval(toolName: string, args: Record<string, unknown>, workspace: string): boolean {
  if (toolName === "edit_file") return true
  if (["write_file", "write_text_file", "write_json_file"].includes(toolName) && args.overwrite === true) return true
  if (!["write_file", "write_text_file", "write_json_file", "create_directory"].includes(toolName) || typeof args.path !== "string" || !isAbsolute(args.path)) return false
  const relativePath = relative(workspace, resolve(args.path))
  return relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath)
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
  const title = conversationTitle(firstUser?.content)
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ id, title, updatedAt: new Date().toISOString(), messages }, null, 2), "utf8")
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
        title: conversationTitle(parsed.title),
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


const WEB_FETCH_TOOLS = [
  { type: "function", function: { name: "web_fetch", description: "Fetch and extract content from one explicit public HTTP(S) URL. This is not a search engine. Returns normalized content and response metadata.", parameters: { type: "object", properties: { url: { type: "string" }, format: { type: "string", enum: ["markdown", "text", "html", "json"] }, max_chars: { type: "integer", minimum: 1000, maximum: 100000 } }, required: ["url"], additionalProperties: false } } },
] as const

const IMAGE_GENERATE_TOOLS = [
  { type: "function", function: { name: "image_generate", description: "Generate a real image artifact when the user asks you to create an image. Use an exact compatible model from the current Image catalog. Pass an explicit user image prompt unchanged.", parameters: { type: "object", properties: { prompt: { type: "string" }, model: { type: "string" }, aspect_ratio: { type: "string", enum: ["auto", "1:1", "9:16", "16:9", "2:3", "3:2"] } }, required: ["prompt"], additionalProperties: false } } },
] as const

async function fetchThrough9Router(request: ApiVaultRequest, url: string, format: WebFetchFormat, maxChars: number, signal?: AbortSignal): Promise<{ url: string; status: number; contentType: string; title: string; content: string; source: string }> {
  const target = validateWebFetchUrl(url)
  const base = request.endpoint.trim().replace(/\/+$/, "")
  const endpoint = base.endsWith("/web/fetch") ? base : `${base}/web/fetch`
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
    body: JSON.stringify({ url: target.href, format, output_format: format, max_chars: maxChars, model: "jina-reader" }),
    signal: requestSignal(30_000, signal),
  })
  if (!response.ok) throw await responseError(response)
  const raw = await response.json() as Record<string, unknown>
  const nested = raw.data && typeof raw.data === "object" ? raw.data as Record<string, unknown> : raw
  const extracted = typeof nested.content === "string" ? nested.content
    : typeof nested.text === "string" ? nested.text
    : typeof nested.markdown === "string" ? nested.markdown
    : typeof nested.output === "string" ? nested.output : ""
  if (!extracted) throw new Error("9Router Web Fetch returned no normalized page content.")
  return {
    url: typeof nested.url === "string" ? nested.url : target.href,
    status: typeof nested.status === "number" ? nested.status : 200,
    contentType: typeof nested.content_type === "string" ? nested.content_type : typeof nested.contentType === "string" ? nested.contentType : "text/markdown",
    title: typeof nested.title === "string" ? nested.title : "",
    content: extracted.slice(0, Math.max(1000, Math.min(100_000, maxChars))),
    source: "9router",
  }
}

async function runWebFetch(request: ApiVaultRequest, rawUrl: string, formatValue: unknown, maxValue: unknown, signal?: AbortSignal) {
  const format: WebFetchFormat = ["markdown", "text", "html", "json"].includes(String(formatValue)) ? formatValue as WebFetchFormat : "markdown"
  const maxChars = typeof maxValue === "number" && Number.isFinite(maxValue) ? Math.max(1000, Math.min(100_000, Math.floor(maxValue))) : 20_000
  const checkedUrl = validateWebFetchUrl(rawUrl).href
  const fetchSignal = requestSignal(30_000, signal)
  if (request.provider !== "9router") {
    return { ...(await fetchWebResource(checkedUrl, format, maxChars, fetchSignal)), source: "local/native" }
  }
  try {
    return { ...(await fetchWebResource(checkedUrl, format, maxChars, fetchSignal)), source: "local/native" }
  } catch (nativeError) {
    if (signal?.aborted) throw nativeError
    try { return await fetchThrough9Router(request, checkedUrl, format, maxChars, fetchSignal) }
    catch (routerError) {
      const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError)
      const routerMessage = routerError instanceof Error ? routerError.message : String(routerError)
      throw new Error(`Local/native Web Fetch failed: ${nativeMessage}. 9Router Web Fetch also failed: ${routerMessage}`)
    }
  }
}

export async function runApiVault(
  installDirectory: string,
  request: ApiVaultRequest,
  onProgress: (event: ApiVaultProgressEvent) => void = () => undefined,
  control: ApiVaultRunControl = {},
): Promise<ApiVaultResponse> {
  if (!request.endpoint.trim() || !request.model.trim() || !request.prompt.trim()) throw new Error("Endpoint, model, and prompt are required.")
  const runId = validRunId(request.runId) ? request.runId : randomUUID()
  const trace: AgentTraceEntry[] = []
  const files: string[] = []
  let model = request.outputKind === "image" ? (request.imageModel?.trim() || request.model) : routedModel(request.model, request.provider, request.reasoning)
  if (request.outputKind === "image") {
    const imageStateDirectory = resolve(installDirectory, "data", "api-vault")
    await mkdir(imageStateDirectory, { recursive: true })
    const imageArtifacts: AgentArtifactState[] = []
    await persistRunState(imageStateDirectory, runId, "running", "Generating requested image", 0, imageArtifacts)
    try {
      onProgress({ runId, phase: "thinking", message: "Requesting the image from the provider…" })
      let generated: Awaited<ReturnType<typeof runImageRequest>>
      try {
        generated = await runImageRequest(request, model, control.signal)
      } catch (error) {
        if (control.signal?.aborted || request.provider !== "9router" || !request.fallbackModel?.trim() || model === request.fallbackModel.trim()) throw error
        model = request.fallbackModel.trim()
        generated = await runImageRequest(request, model, control.signal)
      }
      const generatedFiles = await saveImages(request.outputDirectory || "", runId, generated.sources, control.signal)
      for (const file of generatedFiles) {
        files.push(file)
        imageArtifacts.push(await observeArtifact(installDirectory, file, "created"))
        onProgress({ runId, phase: "tool-succeeded", tool: "save_image", file, message: `Saved ${file}.` })
      }
      await persistRunState(imageStateDirectory, runId, "completed", "Image generation completed", 1, imageArtifacts)
      onProgress({ runId, phase: "completed", message: "Image generation completed." })
      return { runId, text: generated.text, responseId: generated.responseId, model: generated.model, files: generatedFiles, trace: [{ type: "provider", label: generated.model, detail: `Saved ${generatedFiles.length} image(s)` }] }
    } catch (error) {
      await persistRunState(imageStateDirectory, runId, "failed", control.signal?.aborted ? "Image generation was cancelled" : "Image generation failed", 0, imageArtifacts).catch(() => undefined)
      throw error
    }
  }
  const dataDirectory = resolve(installDirectory, "data", "api-vault")
  await mkdir(dataDirectory, { recursive: true })
  const artifactStates: AgentArtifactState[] = []
  let iteration = 0
  await persistRunState(dataDirectory, runId, "running", "Preparing the primary-agent run", iteration, artifactStates)
  const thread = await loadThread(dataDirectory, request)
  const messages: Message[] = thread.messages.filter((message) => message.role !== "system")
  if (request.systemInstruction.trim()) messages.unshift({ role: "system", content: request.systemInstruction.trim() })
  messages.unshift({ role: "system", content: RUNTIME_INSTRUCTION })
  messages.push({ role: "user", content: await buildUserContent(request) })
  const context = createToolContext(installDirectory, request.prompt, request.assets.map((asset) => asset.path))
  await mkdir(context.workspace, { recursive: true })
  const imageModelIds = [...new Set([request.imageModel, ...(request.imageModelCatalog || []).map((item: ApiModelCatalogItem) => item.id)].filter((value): value is string => Boolean(value?.trim())))]
  const imageTools = imageModelIds.length ? IMAGE_GENERATE_TOOLS.map((tool) => ({
    ...tool,
    function: { ...tool.function, parameters: { ...tool.function.parameters, properties: { ...tool.function.parameters.properties, model: { type: "string", enum: imageModelIds } } } },
  })) : []
  const tools = [...FILESYSTEM_TOOLS, ...WEB_FETCH_TOOLS, ...imageTools].filter((tool) => context.allowWrite || !["create_directory", "write_file", "edit_file", "write_text_file", "write_json_file"].includes(tool.function.name))
  let responseId: string | undefined
  let finalText = ""
  let calls = 0

  try {
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    iteration = round + 1
    trace.push({ type: "provider", label: model, detail: `Request ${round + 1}` })
    onProgress({ runId, phase: "thinking", message: round === 0 ? "Analyzing the request…" : "Continuing with the tool results…" })
    let response: OpenAiResponse
    try {
      response = request.provider === "gemini" ? await callGemini(request, messages, tools, (delta) => onProgress({ runId, phase: "assistant", message: delta, textDelta: delta }), control.signal) : await callOpenAi(request, model, messages, tools, (delta) => onProgress({ runId, phase: "assistant", message: delta, textDelta: delta }), control.signal)
    } catch (error) {
      if (request.provider !== "9router" || !request.fallbackModel?.trim() || model === routedModel(request.fallbackModel, request.provider, request.reasoning)) throw error
      model = routedModel(request.fallbackModel, request.provider, request.reasoning)
      trace.push({ type: "provider", label: model, detail: `Fallback after: ${error instanceof Error ? error.message : String(error)}` })
      if (control.signal?.aborted) throw new Error("Run was cancelled.")
      response = await callOpenAi(request, model, messages, tools, (delta) => onProgress({ runId, phase: "assistant", message: delta, textDelta: delta }), control.signal)
    }
    responseId = response.id
    const message = response.choices![0].message!
    const toolCalls = message.tool_calls || []
    messages.push({ role: "assistant", content: message.content || "", tool_calls: toolCalls.length ? toolCalls : undefined })
    if (!toolCalls.length) { finalText = assistantText(message.content); break }
    if (control.signal?.aborted) throw new Error("Run was cancelled.")
    if (round === MAX_TOOL_ROUNDS) throw new Error(`Tool execution exceeded ${MAX_TOOL_ROUNDS} rounds.`)
    for (const call of toolCalls) {
      if (control.signal?.aborted) throw new Error("Run was cancelled.")
      calls += 1
      if (calls > MAX_TOOL_CALLS) throw new Error(`Tool execution exceeded ${MAX_TOOL_CALLS} calls.`)
      let args: Record<string, unknown>
      try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown> } catch { throw new Error(`Tool ${call.function.name} returned invalid JSON arguments.`) }
      trace.push({ type: "tool", label: call.function.name, detail: typeof args.path === "string" ? args.path : "" })
      onProgress({ runId, phase: "tool-started", tool: call.function.name, message: toolProgress(call.function.name, args, false) })
      if (control.approveToolCall && requiresTelegramApproval(call.function.name, args, context.workspace)) {
        const approved = await control.approveToolCall(call.function.name, args).catch(() => false)
        if (!approved) {
          const detail = "The requested operation was not approved in Telegram; no filesystem change was made."
          messages.push({ role: "tool", tool_call_id: call.id, tool_name: call.function.name, content: JSON.stringify({ error: detail }) })
          trace.push({ type: "result", label: call.function.name, detail })
          onProgress({ runId, phase: "tool-failed", tool: call.function.name, message: detail })
          continue
        }
      }
      try {
        let result: { content: string; file?: string }
        if (call.function.name === "web_fetch") {
          if (typeof args.url !== "string" || !args.url.trim()) throw new Error("web_fetch requires a URL.")
          const fetched = await withToolTimeout(runWebFetch(request, args.url, args.format, args.max_chars, control.signal), 30_000, control.signal)
          result = { content: JSON.stringify(fetched) }
        } else if (call.function.name === "image_generate") {
          if (typeof args.prompt !== "string" || !args.prompt.length) throw new Error("image_generate requires a prompt.")
          const selectedImageModel = typeof args.model === "string" && args.model.trim() ? args.model.trim() : (request.imageModel || "")
          if (!selectedImageModel) throw new Error("No Image model is configured. Refresh or select an Image model first.")
          if (request.imageModelCatalog?.length && !request.imageModelCatalog.some((item) => item.id === selectedImageModel) && selectedImageModel !== request.imageModel) {
            throw new Error("image_generate selected a model that is not present in the current Image catalog.")
          }
          const outputDirectory = join(context.workspace, "images")
          await mkdir(outputDirectory, { recursive: true })
          const imageRequest: ApiVaultRequest = {
            ...request, model: selectedImageModel, imageModel: selectedImageModel,
            imageAspectRatio: (["auto", "1:1", "9:16", "16:9", "2:3", "3:2"].includes(String(args.aspect_ratio)) ? String(args.aspect_ratio) : request.imageAspectRatio || "auto") as ApiVaultRequest["imageAspectRatio"],
            prompt: args.prompt, systemInstruction: "", assets: [], outputKind: "image", outputDirectory, executionMode: "independent",
          }
          const generated = await withToolTimeout(runImageRequest(imageRequest, selectedImageModel, control.signal), 120_000, control.signal)
          const saved = await saveImages(outputDirectory, `${runId}-image-${calls}`, generated.sources, control.signal)
          saved.forEach((file) => files.push(file))
          result = { content: JSON.stringify({ generated: true, model: generated.model, files: saved, note: "The explicit image prompt was sent unchanged." }), file: saved[0] }
        } else {
          result = await withToolTimeout(executeFilesystemTool(context, call.function.name, args), TOOL_TIMEOUT_MS, control.signal)
        }
        if (result.file) {
          if (!files.includes(result.file)) files.push(result.file)
          const existingArtifact = artifactStates.find((artifact) => resolve(installDirectory, artifact.path) === resolve(result.file!))
          const operation = call.function.name === "edit_file" ? "modified" : "created"
          const observed = await observeArtifact(installDirectory, result.file, operation, existingArtifact)
          if (existingArtifact) Object.assign(existingArtifact, observed)
          else artifactStates.push(observed)
          await persistRunState(dataDirectory, runId, "running", "Completed tool operation: " + call.function.name, iteration, artifactStates)
        }
        messages.push({ role: "tool", tool_call_id: call.id, tool_name: call.function.name, content: result.content })
        trace.push({ type: "result", label: call.function.name, detail: result.content.slice(0, 500) })
        onProgress({ runId, phase: "tool-succeeded", tool: call.function.name, file: result.file, message: toolProgress(call.function.name, args, true, result.file) })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        messages.push({ role: "tool", tool_call_id: call.id, tool_name: call.function.name, content: JSON.stringify({ error: detail }) })
        trace.push({ type: "result", label: call.function.name, detail })
        onProgress({ runId, phase: "tool-failed", tool: call.function.name, message: `${call.function.name} failed: ${detail}` })
      }
    }
  }
  } catch (error) {
    await persistRunState(dataDirectory, runId, "failed", "Run stopped before the requested work completed", iteration, artifactStates).catch(() => undefined)
    throw error
  }
  if (!finalText.trim()) {
    await persistRunState(dataDirectory, runId, "failed", "Provider returned an empty final response", iteration, artifactStates).catch(() => undefined)
    throw new Error("Provider returned an empty final response.")
  }
  const persistsConversation = request.executionMode === "agent"
  if (persistsConversation) await saveThread(dataDirectory, thread.id, messages)
  const selectedThreadId = request.conversationMode === "continue" && validThreadId(request.threadId) ? request.threadId : undefined
  await persistRunState(dataDirectory, runId, "completed", "Requested task completed", iteration, artifactStates)
  onProgress({ runId, phase: "completed", message: files.length ? `Completed with ${files.length} saved file${files.length === 1 ? "" : "s"}.` : "Run completed." })
  return { runId, text: finalText, responseId, model, threadId: persistsConversation ? thread.id : selectedThreadId, files, trace }
}
