export type ApiProvider = "gemini" | "openai" | "9router" | "custom"
export type ApiExecutionMode = "independent" | "prompt" | "agent"
export type ApiOutputKind = "text" | "image"
export type ApiModelCatalogItem = { id: string; owned_by?: string; outputType: ApiOutputKind; capabilities?: { textInput?: boolean | "unknown"; imageInput?: boolean | "unknown"; imageGeneration?: boolean | "unknown"; toolCalling?: boolean | "unknown"; structuredOutput?: boolean | "unknown" } }
export type ApiVaultModelCatalogs = Record<ApiProvider, { chat: ApiModelCatalogItem[]; image: ApiModelCatalogItem[]; chatRefreshedAt?: string | null; imageRefreshedAt?: string | null }>
export type ConversationMode = "independent" | "continue" | "chain"
export type ReasoningLevel = "default" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

export type ApiVaultAsset = {
  id: string
  path: string
  name: string
  kind: "image" | "document"
}

export type ApiVaultRequest = {
  runId?: string
  provider: ApiProvider
  endpoint: string
  apiKey: string
  model: string
  imageModel?: string
  imageAspectRatio?: "auto" | "1:1" | "9:16" | "16:9" | "2:3" | "3:2"
  fallbackModel?: string
  reasoning: ReasoningLevel
  outputKind: ApiOutputKind
  outputDirectory?: string
  executionMode: ApiExecutionMode
  conversationMode: ConversationMode
  threadId?: string
  systemInstruction: string
  prompt: string
  assets: ApiVaultAsset[]
}

export type ApiVaultProgressEvent = {
  runId: string
  phase: "thinking" | "assistant" | "tool-started" | "tool-succeeded" | "tool-failed" | "completed" | "failed"
  message: string
  tool?: string
  file?: string
}

export type AgentTraceEntry = {
  type: "provider" | "tool" | "result"
  label: string
  detail: string
}

export type ApiVaultResponse = {
  runId: string
  text: string
  responseId?: string
  model: string
  threadId?: string
  files: string[]
  trace: AgentTraceEntry[]
}

export type ApiVaultConversation = {
  id: string
  title: string
  updatedAt: string
  turnCount: number
}

export type ApiVaultProviderSettings = {
  endpoint: string
  apiKey: string
  model: string
  imageModel?: string
  imageAspectRatio?: "auto" | "1:1" | "9:16" | "16:9" | "2:3" | "3:2"
  fallbackModel: string
  reasoning: ReasoningLevel
}

export type ApiVaultSettings = {
  version: 1
  activeProvider: ApiProvider
  providers: Record<ApiProvider, ApiVaultProviderSettings>
  executionMode?: ApiExecutionMode
  conversationMode?: ConversationMode
  modelCatalogs?: ApiVaultModelCatalogs
}

export const REASONING_LEVELS: ReadonlyArray<{ value: ReasoningLevel; label: string }> = [
  { value: "default", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
]

export function routedModel(model: string, provider: ApiProvider, reasoning: ReasoningLevel): string {
  const trimmed = model.trim()
  if (provider !== "9router" || reasoning === "default") return trimmed
  return `${trimmed.replace(/\((?:low|medium|high|xhigh|max|ultra)\)$/i, "")}(${reasoning})`
}
