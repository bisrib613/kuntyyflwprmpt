import { describe, expect, it } from "vitest"
import { normalizeCompleteVisibleText, VisibleTextNormalizer } from "../src/sidecar/api-vault/stream-normalizer"

describe("model-targeted visible-text normalization", () => {
  it("removes split Qwen tool envelopes without treating text as a tool execution", () => {
    const normalizer = new VisibleTextNormalizer("Qwen3-Next")
    const chunks = ["Before ", "<tool_", "call>{\"name\":\"write_file\"}", "</tool_call>", " after."]
    const output = chunks.map((chunk) => normalizer.feed(chunk)).join("") + normalizer.flush()
    expect(output).toBe("Before  after.")
  })

  it("removes a reasoning envelope when its delimiters span chunks", () => {
    const normalizer = new VisibleTextNormalizer("gemini-2.5-flash-thinking")
    const output = ["Answer ", "<thi", "nk>private reasoning", "</th", "ink>visible answer"].map((chunk) => normalizer.feed(chunk)).join("") + normalizer.flush()
    expect(output).toBe("Answer visible answer")
  })

  it("removes a split DSML tool section only for a matching model family", () => {
    const normalizer = new VisibleTextNormalizer("deepseek-v3")
    const output = ["Found it. <｜DSML｜tool_calls>", "invoke name=\"read_file\"", "</｜DSML｜tool_calls> Done."].map((chunk) => normalizer.feed(chunk)).join("") + normalizer.flush()
    expect(output).toBe("Found it.  Done.")
  })

  it("preserves ordinary XML/HTML examples and unknown-model text", () => {
    const text = "Literal <tag>value</tag>; fenced sample: ```html\n<script>example()</script>\n```."
    expect(normalizeCompleteVisibleText(text, "gpt-5")).toBe(text)
    expect(normalizeCompleteVisibleText("XML <tag>okay</tag>", "qwen3")).toBe("XML <tag>okay</tag>")
  })

  it("preserves an unmatched literal less-than fragment at end-of-stream", () => {
    const normalizer = new VisibleTextNormalizer("qwen3")
    expect(normalizer.feed("Math pH <")).toBe("Math pH ")
    expect(normalizer.flush()).toBe("<")
  })

  it("heals a thinking fence whose backticks and newline are split across chunks", () => {
    const normalizer = new VisibleTextNormalizer("qwen-thinking")
    const output = ["Visible\n", "`", "``thinking\nprivate", "\n", "```", "\nAfter"].map((chunk) => normalizer.feed(chunk)).join("") + normalizer.flush()
    expect(output).toBe("Visible\n\nAfter")
  })

  it("drops an incomplete hidden reasoning block instead of leaking its tail", () => {
    const normalizer = new VisibleTextNormalizer("gemini-thinking")
    expect(normalizer.feed("visible<think>private fragments")).toBe("visible")
    expect(normalizer.flush()).toBe("")
  })
})
