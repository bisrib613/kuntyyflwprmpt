export function parsePromptFile(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim()
  if (!normalized) return []
  const separator = /^\s*---+\s*$/m.test(normalized) ? /^\s*---+\s*$/gm : /\n\s*\n+/g
  return normalized.split(separator).map((prompt) => prompt.trim()).filter(Boolean)
}
