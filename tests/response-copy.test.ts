import { describe, expect, it } from "vitest"
import { extractFencedCode } from "../src/shared/response-copy"

describe("fenced-code copy extraction", () => {
  it("copies code without removing the surrounding response", () => {
    const response = "Here is the page.\n\n```html\n<!doctype html>\n<div>hello</div>\n```\n\nThe div contains the greeting."
    expect(extractFencedCode(response)).toBe("<!doctype html>\n<div>hello</div>")
    expect(response).toContain("Here is the page.")
    expect(response).toContain("The div contains the greeting.")
  })

  it("collects multiple fenced code blocks in order", () => {
    const response = "Example A:\n```js\nconst a = 1\n```\nThen B:\n~~~css\nbody { color: red; }\n~~~"
    expect(extractFencedCode(response)).toBe("const a = 1\n\nbody { color: red; }")
  })

  it("returns an empty string when no fenced code exists", () => {
    expect(extractFencedCode("Just a plain-text answer.")).toBe("")
    expect(extractFencedCode("Inline `const x = 1` is not a fenced block.")).toBe("")
  })

  it("accepts a longer closing fence and preserves code without the fences", () => {
    expect(extractFencedCode("```js\\nconst x = 1\\n````")).toBe("const x = 1")
  })

  it("copies code from an unfinished final fence", () => {
    expect(extractFencedCode("```html\\n<div>still generating</div>")).toBe("<div>still generating</div>")
  })

  it("normalizes CRLF while keeping distinct blocks in order", () => {
    const response = "```js\\r\\nconst a = 1\\r\\n```\\r\\n\\r\\n~~~css\\r\\nbody {}\\r\\n~~~"
    expect(extractFencedCode(response)).toBe("const a = 1\\n\\nbody {}")
  })

  it("copies fenced HTML as literal source", () => {
    const response = "```html\n<script>doSomething()</script>\n```"
    expect(extractFencedCode(response)).toBe("<script>doSomething()</script>")
  })
})
