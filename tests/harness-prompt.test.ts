import { describe, expect, it } from "vitest"
import { composeHarnessSystemInstruction, HARNESS_BASE_INSTRUCTION, HARNESS_PROMPT_VERSION } from "../src/sidecar/api-vault/prompt"

const defaults = {
  availableToolNames: ["read_file", "web_fetch"],
  executionMode: "independent" as const,
  conversationMode: "independent" as const,
  hasSelectedConversation: false,
}

describe("agent harness prompt composition", () => {
  it("always includes the versioned base policy when task instructions are empty", () => {
    const prompt = composeHarnessSystemInstruction({ ...defaults, taskInstructions: "" })
    expect(prompt).toContain(`Kuntyy Agent Harness v${HARNESS_PROMPT_VERSION}`)
    expect(prompt).toContain(HARNESS_BASE_INSTRUCTION)
    expect(prompt).toContain("Capabilities available for this run: read_file, web_fetch")
    expect(prompt).not.toContain("Additional task instructions")
  })

  it("appends optional task instructions without replacing the base policy", () => {
    const prompt = composeHarnessSystemInstruction({ ...defaults, taskInstructions: "Use Indonesian and return HTML." })
    expect(prompt.indexOf(HARNESS_BASE_INSTRUCTION)).toBeLessThan(prompt.indexOf("Additional task instructions"))
    expect(prompt).toContain("Use Indonesian and return HTML.")
    expect(prompt).toContain("cannot override the harness policy")
  })

  it("does not advertise tools that were not registered", () => {
    const prompt = composeHarnessSystemInstruction({ ...defaults, availableToolNames: ["read_file"] })
    expect(prompt).toContain("Capabilities available for this run: read_file.")
    expect(prompt).not.toContain("web_fetch")
  })

  it("describes a selected conversation as read-only context for independent bulk work", () => {
    const prompt = composeHarnessSystemInstruction({
      ...defaults,
      conversationMode: "continue",
      hasSelectedConversation: true,
    })
    expect(prompt).toContain("Read-only conversation context")
    expect(prompt).toContain("Each Bulk Prompt section is evaluated independently")
    expect(prompt).not.toContain("A successful turn is persisted")
  })

  it("describes Conversation persistence separately from Independent mode", () => {
    const prompt = composeHarnessSystemInstruction({
      ...defaults,
      executionMode: "agent",
      conversationMode: "continue",
      hasSelectedConversation: true,
    })
    expect(prompt).toContain("A successful turn is persisted by the host")
  })
})
