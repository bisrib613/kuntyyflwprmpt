export type ApiProvider = "gemini" | "openai" | "9router" | "custom"
export type ApiExecutionMode = "prompt" | "agent"
export type ApiOutputKind = "text" | "image"
export type ConversationMode = "independent" | "continue" | "chain"
export type ReasoningLevel = "default" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

export type ApiVaultAsset = {
  id: string
  path: string
  name: string
  kind: "image" | "document"
}

export type ApiVaultRequest = {
  provider: ApiProvider
  endpoint: string
  apiKey: string
  model: string
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
  fallbackModel: string
  reasoning: ReasoningLevel
}

export type ApiVaultSettings = {
  version: 1
  activeProvider: ApiProvider
  providers: Record<ApiProvider, ApiVaultProviderSettings>
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
