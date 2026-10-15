import { describe, expect, it } from "vitest"
import { executionModeForContextMode, requestConversationMode, restoreContextMode } from "../src/shared/context-mode"

describe("context mode mapping", () => {
  it("maps Independent to a fresh, unsaved run", () => {
    expect(executionModeForContextMode("independent")).toBe("independent")
    expect(requestConversationMode("independent")).toBe("independent")
  })

  it("maps Conversation to the persistent agent branch", () => {
    expect(executionModeForContextMode("continue")).toBe("agent")
    expect(requestConversationMode("continue")).toBe("continue")
  })

  it("maps Bulk Prompt to an unsaved run that may load selected history", () => {
    expect(executionModeForContextMode("chain")).toBe("independent")
    expect(requestConversationMode("chain")).toBe("chain")
  })

  it("preserves old persisted Conversation mode", () => {
    expect(restoreContextMode("agent", "continue")).toBe("continue")
    expect(restoreContextMode("agent", undefined)).toBe("continue")
  })

  it("migrates the old unsaved context branch to Bulk Prompt semantics", () => {
    expect(restoreContextMode("independent", "continue")).toBe("chain")
    expect(restoreContextMode("prompt", "continue")).toBe("chain")
  })

  it("preserves legacy Bulk Prompt mode regardless of old execution dropdown", () => {
    expect(restoreContextMode("agent", "chain")).toBe("chain")
    expect(restoreContextMode("independent", "chain")).toBe("chain")
  })
})
