import type { ApiExecutionMode, ConversationMode } from "./api-vault"

export function restoreContextMode(
  executionMode: ApiExecutionMode | undefined,
  conversationMode: ConversationMode | undefined,
): ConversationMode {
  if (conversationMode === "chain") return "chain"
  if (conversationMode === "continue") return executionMode === "agent" ? "continue" : "chain"
  if (executionMode === "agent") return "continue"
  return "independent"
}

export function executionModeForContextMode(contextMode: ConversationMode): "independent" | "agent" {
  return contextMode === "continue" ? "agent" : "independent"
}

export function requestConversationMode(contextMode: ConversationMode): ConversationMode {
  return contextMode
}
