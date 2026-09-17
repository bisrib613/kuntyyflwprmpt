import { describe, expect, it } from "vitest"
import { parsePromptFile, parsePromptText } from "../src/shared/prompt-file"

describe("prompt file parser", () => {
  it("supports explicit separators", () => {
    expect(parsePromptFile("first prompt\n---\nsecond prompt")).toEqual(["first prompt", "second prompt"])
  })

  it("supports blank-line bulk without requiring add job", () => {
    expect(parsePromptFile("first prompt\n\nsecond prompt\n\n\nthird prompt")).toEqual(["first prompt", "second prompt", "third prompt"])
  })

  it("ignores empty files", () => expect(parsePromptFile(" \r\n ")).toEqual([]))

  it("keeps paragraph breaks inside manually entered prompts", () => {
    expect(parsePromptText("first paragraph\n\nsecond paragraph")).toEqual(["first paragraph\n\nsecond paragraph"])
  })

  it("splits manually entered bulk prompts only on explicit separators", () => {
    expect(parsePromptText("first prompt\n---\nsecond prompt")).toEqual(["first prompt", "second prompt"])
  })
})
