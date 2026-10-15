import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { routedModel, type ApiVaultRequest } from "../src/shared/api-vault"
import { validateWebFetchUrl } from "../src/sidecar/api-vault/web-fetch"
import { listApiVaultModelCatalog } from "../src/sidecar/api-vault/runner"
import { createToolContext, executeFilesystemTool, resolveToolPath } from "../src/sidecar/api-vault/filesystem"
import { deleteApiVaultConversation, listApiVaultConversations, runApiVault } from "../src/sidecar/api-vault/runner"

describe("API Vault reasoning", () => {
  it("uses the documented 9Router model suffix without stacking suffixes", () => {
    expect(routedModel("ag/gemini-3.6-flash-low", "9router", "high")).toBe("ag/gemini-3.6-flash-low(high)")
    expect(routedModel("ag/gemini-3.6-flash-low(low)", "9router", "ultra")).toBe("ag/gemini-3.6-flash-low(ultra)")
    expect(routedModel("gpt-5", "openai", "high")).toBe("gpt-5")
  })
})

describe("API Vault filesystem boundary", () => {
  it("supports canonical write_file and unique targeted edit_file tools", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-canonical-"))
    const context = createToolContext(install, "Create and save a config file", [])
    const target = path.join(install, ".agents", "config.md")
    const written = await executeFilesystemTool(context, "write_file", { path: "config.md", content: "before\\nvalue=1\\nafter\\n" })
    expect(written.file).toBe(target)
    const edited = await executeFilesystemTool(context, "edit_file", { path: "config.md", old_text: "value=1", new_text: "value=2" })
    expect(edited.file).toBe(target)
    expect(await readFile(target, "utf8")).toBe("before\\nvalue=2\\nafter\\n")
    await expect(executeFilesystemTool(context, "edit_file", { path: "config.md", old_text: "missing", new_text: "x" })).rejects.toThrow(/could not find/)
  })

  it("writes relative files below .agents and blocks traversal", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-"))
    const context = createToolContext(install, "Save result.json", [])
    const result = await executeFilesystemTool(context, "write_json_file", { path: "reports/result.json", content: { ok: true } })
    expect(result.file).toBe(path.join(install, ".agents", "reports", "result.json"))
    expect(JSON.parse(await readFile(result.file!, "utf8"))).toEqual({ ok: true })
    await expect(executeFilesystemTool(context, "write_json_file", { path: "reports/result.json", content: { ok: false }, overwrite: true })).rejects.toThrow(/blocked overwrite/)
    await expect(resolveToolPath(context, "../escape.json", "write")).rejects.toThrow(/blocked write/)
  })

  it("allows an external destination only when the direct prompt names it", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-install-"))
    const external = path.join(await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-external-")), "result.json")
    const denied = createToolContext(install, "Save the result", [])
    await expect(resolveToolPath(denied, external, "write")).rejects.toThrow(/blocked write/)
    const allowed = createToolContext(install, `Save to "${external}"`, [])
    expect(await resolveToolPath(allowed, external, "write")).toBe(external)
    await expect(resolveToolPath(allowed, path.join(path.dirname(external), "invented.json"), "write")).rejects.toThrow(/blocked write/)
  })
})

describe("API Vault web fetch URL boundary", () => {
  it("allows public HTTP(S) URLs and rejects internal or non-HTTP destinations", () => {
    expect(validateWebFetchUrl("https://example.com/a").hostname).toBe("example.com")
    expect(validateWebFetchUrl("http://8.8.8.8/").protocol).toBe("http:")
    expect(() => validateWebFetchUrl("file:///etc/passwd")).toThrow(/http/)
    expect(() => validateWebFetchUrl("http://localhost:3000/")).toThrow(/local or internal/)
    expect(() => validateWebFetchUrl("http://127.0.0.1/")).toThrow(/private|non-public/)
    expect(() => validateWebFetchUrl("http://192.168.1.1/")).toThrow(/private|non-public/)
    expect(() => validateWebFetchUrl("https://user:pass@example.com/")).toThrow(/credentials/)
  })
})

describe("API Vault model catalogs", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("retries local 9Router model discovery over IPv4 when localhost connection fails", async () => {
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const address = String(input)
      urls.push(address)
      const headers = init?.headers as Record<string, string> | undefined
      expect(headers?.authorization).toBeUndefined()
      if (address === "http://localhost:20128/v1/models/image" || address === "http://localhost:20128/v1/models/info?id=ag%2Fimage-model") {
        throw new Error("fetch failed")
      }
      if (address === "http://127.0.0.1:20128/v1/models/image") {
        return new Response(JSON.stringify({ data: [{ id: "ag/image-model", owned_by: "antigravity" }] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      expect(address).toBe("http://127.0.0.1:20128/v1/models/info?id=ag%2Fimage-model")
      return new Response(JSON.stringify({ data: { capabilities: { image_generation: true } } }), { status: 200, headers: { "content-type": "application/json" } })
    })
    vi.stubGlobal("fetch", fetchMock)

    const models = await listApiVaultModelCatalog("9router", "http://localhost:20128/v1", "", "image")
    expect(models).toMatchObject([{ id: "ag/image-model", owned_by: "antigravity", outputType: "image", capabilities: { imageGeneration: true } }])
    expect(urls).toEqual([
      "http://localhost:20128/v1/models/image",
      "http://127.0.0.1:20128/v1/models/image",
      "http://localhost:20128/v1/models/info?id=ag%2Fimage-model",
      "http://127.0.0.1:20128/v1/models/info?id=ag%2Fimage-model",
    ])
  })

  it("loads the separate 9Router image catalog and preserves owned_by", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const address = String(url)
      if (address === "http://localhost:20128/v1/models/image") {
        return new Response(JSON.stringify({ data: [{ id: "ag/image-model", owned_by: "antigravity" }] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      expect(address).toBe("http://localhost:20128/v1/models/info?id=ag%2Fimage-model")
      return new Response(JSON.stringify({ data: { capabilities: { image_generation: true, tool_calling: false } } }), { status: 200, headers: { "content-type": "application/json" } })
    })
    vi.stubGlobal("fetch", fetchMock)
    await expect(listApiVaultModelCatalog("9router", "http://localhost:20128/v1", "test-key", "image"))
      .resolves.toEqual([{
        id: "ag/image-model", owned_by: "antigravity", outputType: "image", supportedParameters: [],
        capabilities: {
          textInput: "unknown", imageInput: "unknown", imageGeneration: true,
          toolCalling: false, structuredOutput: "unknown",
        },
      }])
  })

  it("does not mislabel the Gemini text catalog as an Image catalog", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(listApiVaultModelCatalog("gemini", "https://generativelanguage.googleapis.com/v1beta", "key", "image")).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("API Vault agent loop", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("does not attach an automatic deadline to a provider request", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-no-timeout-"))
    const controller = new AbortController()
    const fetchSignals: AbortSignal[] = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) fetchSignals.push(init.signal)
      return new Response(JSON.stringify({
        id: "no-deadline", model: "test-model", choices: [{ message: { role: "assistant", content: "Completed after a long wait." } }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }))
    const request: ApiVaultRequest = {
      provider: "custom", endpoint: "http://localhost:9999/v1", apiKey: "local", model: "test-model",
      reasoning: "default", outputKind: "text", executionMode: "prompt", conversationMode: "independent",
      systemInstruction: "", prompt: "Continue until the provider responds.", assets: [],
    }
    const result = await runApiVault(install, request, () => undefined, { signal: controller.signal })
    expect(result.text).toBe("Completed after a long wait.")
    expect(fetchSignals).toHaveLength(1)
    expect(fetchSignals[0]).toBe(controller.signal)
  })

  it("explains a real 9Router timeout without inventing a deadline", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-timeout-"))
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("The operation was aborted due to timeout") }))
    const request: ApiVaultRequest = {
      provider: "9router", endpoint: "http://localhost:20128/v1", apiKey: "local", model: "ag/test-model",
      reasoning: "default", outputKind: "text", executionMode: "prompt", conversationMode: "independent",
      systemInstruction: "", prompt: "6", assets: [],
    }
    await expect(runApiVault(install, request)).rejects.toThrow(
      "The model request to 9Router was interrupted by a timeout. Make sure 9Router is running and the selected model is available, then try again.",
    )
  })

  it("uses provider-appropriate guidance for an actual provider timeout", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-timeout-provider-"))
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("The operation was aborted due to timeout") }))
    const request: ApiVaultRequest = {
      provider: "custom", endpoint: "http://localhost:9999/v1", apiKey: "local", model: "test-model",
      reasoning: "default", outputKind: "text", executionMode: "prompt", conversationMode: "independent",
      systemInstruction: "", prompt: "6", assets: [],
    }
    await expect(runApiVault(install, request)).rejects.toThrow(
      "The model request to configured provider was interrupted by a timeout. Check the Base URL and model availability, then try again.",
    )
  })

  it("executes a provider tool call and returns the final provider response", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-agent-"))
    let requestCount = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ id: "first", model: "test-model", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "write_json_file", arguments: JSON.stringify({ path: "answer.json", content: { answer: 42 } }) } }] } }] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ id: "second", model: "test-model", choices: [{ message: { role: "assistant", content: "Saved answer.json." } }] }), { status: 200, headers: { "content-type": "application/json" } })
    }))
    const request: ApiVaultRequest = {
      provider: "custom", endpoint: "http://localhost:9999/v1", apiKey: "local", model: "test-model",
      reasoning: "default", outputKind: "text", executionMode: "agent", conversationMode: "independent",
      systemInstruction: "", prompt: "Save the answer as answer.json", assets: [],
    }
    const result = await runApiVault(install, request)
    expect(result.text).toBe("Saved answer.json.")
    expect(result.files).toEqual([path.join(install, ".agents", "answer.json")])
    expect(JSON.parse(await readFile(result.files[0], "utf8"))).toEqual({ answer: 42 })
    expect(requestCount).toBe(2)
  })

  it("extracts structured text content instead of rendering a blank result", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-parts-"))
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "parts", model: "test-model", choices: [{ message: { role: "assistant", content: [{ type: "text", text: "Second answer" }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } })))
    const request: ApiVaultRequest = {
      provider: "custom", endpoint: "http://localhost:9999/v1", apiKey: "local", model: "test-model",
      reasoning: "default", outputKind: "text", executionMode: "agent", conversationMode: "independent",
      systemInstruction: "", prompt: "Second prompt", assets: [],
    }
    expect((await runApiVault(install, request)).text).toBe("Second answer")
  })

  it("continues, lists, and deletes a locally saved conversation", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-thread-"))
    const requestBodies: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = []
    let requestCount = 0
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      requestCount += 1
      return new Response(JSON.stringify({
        id: `response-${requestCount}`, model: "test-model", choices: [{ message: { role: "assistant", content: requestCount === 1 ? "First answer" : "Second answer" } }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }))
    const base: ApiVaultRequest = {
      provider: "custom", endpoint: "http://localhost:9999/v1", apiKey: "local", model: "test-model",
      reasoning: "default", outputKind: "text", executionMode: "agent", conversationMode: "continue",
      systemInstruction: "Stay concise", prompt: "# **First prompt**", assets: [],
    }
    const first = await runApiVault(install, base)
    const second = await runApiVault(install, { ...base, threadId: first.threadId, prompt: "Second prompt" })
    expect(second.text).toBe("Second answer")
    expect(requestBodies[1].messages?.map((message) => message.role)).toEqual(["system", "system", "user", "assistant", "user"])
    const conversations = await listApiVaultConversations(install)
    expect(conversations).toMatchObject([{ id: first.threadId, title: "First prompt", turnCount: 2 }])
    await deleteApiVaultConversation(install, first.threadId!)
    expect(await listApiVaultConversations(install)).toEqual([])
  })

  it("runs Prompt tools from an Agent conversation branch without changing saved history", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-mode-"))
    const requestBodies: Array<{ tools?: unknown[]; messages?: Array<{ role?: string; content?: unknown; tool_calls?: unknown }> }> = []
    let requestCount = 0
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          id: "agent-tool", model: "test-model", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "write_json_file", arguments: JSON.stringify({ path: "answer.json", content: { answer: 42 } }) } }] } }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (requestCount === 2) {
        return new Response(JSON.stringify({ id: "agent-final", model: "test-model", choices: [{ message: { role: "assistant", content: "Saved answer.json." } }] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (requestCount === 3) {
        return new Response(JSON.stringify({
          id: "prompt-tool", model: "test-model", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-2", type: "function", function: { name: "write_json_file", arguments: JSON.stringify({ path: "branch.json", content: { branch: true } }) } }] } }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ id: "prompt-final", model: "test-model", choices: [{ message: { role: "assistant", content: "Saved branch.json." } }] }), { status: 200, headers: { "content-type": "application/json" } })
    }))
    const base: ApiVaultRequest = {
      provider: "custom", endpoint: "http://localhost:9999/v1", apiKey: "local", model: "test-model",
      reasoning: "default", outputKind: "text", executionMode: "agent", conversationMode: "continue",
      systemInstruction: "", prompt: "Save the answer as answer.json", assets: [],
    }
    const first = await runApiVault(install, base)
    const second = await runApiVault(install, { ...base, executionMode: "prompt", threadId: first.threadId, prompt: "Save this branch as branch.json" })
    expect(second.text).toBe("Saved branch.json.")
    expect(second.threadId).toBe(first.threadId)
    expect(await readFile(path.join(install, ".agents", "branch.json"), "utf8")).toBe(JSON.stringify({ branch: true }, null, 2))
    expect(requestBodies[2].tools?.length).toBeGreaterThan(0)
    expect(requestBodies[2].messages?.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"])
    expect(requestBodies[2].messages?.some((message) => message.role === "tool" || message.tool_calls)).toBe(true)
    expect(await listApiVaultConversations(install)).toMatchObject([{ id: first.threadId, turnCount: 1 }])
  })

  it("runs Bulk Prompt against the same saved conversation snapshot without chaining or persisting results", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-bulk-context-"))
    const requestBodies: Array<{ tools?: unknown[]; messages?: Array<{ role?: string; content?: unknown; tool_calls?: unknown }> }> = []
    let requestCount = 0
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          id: "seed-agent", model: "test-model", choices: [{ message: { role: "assistant", content: "Saved seed context." } }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (requestCount === 2) {
        return new Response(JSON.stringify({
          id: "bulk-tool", model: "test-model", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "bulk-call", type: "function", function: { name: "write_json_file", arguments: JSON.stringify({ path: "bulk-result.json", content: { batch: 1 } }) } }] } }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (requestCount === 3) {
        return new Response(JSON.stringify({
          id: "bulk-final", model: "test-model", choices: [{ message: { role: "assistant", content: "Saved bulk-result.json." } }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({
        id: `bulk-independent-${requestCount}`, model: "test-model", choices: [{ message: { role: "assistant", content: "Second bulk section completed from the saved snapshot." } }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }))
    const base: ApiVaultRequest = {
      provider: "custom", endpoint: "http://localhost:9999/v1", apiKey: "local", model: "test-model",
      reasoning: "default", outputKind: "text", executionMode: "agent", conversationMode: "continue",
      systemInstruction: "", prompt: "Establish the conversation context.", assets: [],
    }
    const seed = await runApiVault(install, base)
    expect(seed.threadId).toBeTruthy()

    const firstBulk = await runApiVault(install, {
      ...base, executionMode: "prompt", conversationMode: "chain", threadId: seed.threadId,
      prompt: "Bulk section one: save bulk-result.json",
    })
    const secondBulk = await runApiVault(install, {
      ...base, executionMode: "prompt", conversationMode: "chain", threadId: seed.threadId,
      prompt: "Bulk section two: use the original context",
    })

    expect(firstBulk.text).toBe("Saved bulk-result.json.")
    expect(secondBulk.text).toBe("Second bulk section completed from the saved snapshot.")
    expect(firstBulk.threadId).toBe(seed.threadId)
    expect(secondBulk.threadId).toBe(seed.threadId)
    const secondBulkMessages = requestBodies[3].messages || []
    const secondBulkContent = JSON.stringify(secondBulkMessages)
    expect(secondBulkMessages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"])
    expect(secondBulkContent).toContain("Establish the conversation context.")
    expect(secondBulkContent).toContain("Saved seed context.")
    expect(secondBulkContent).toContain("Bulk section two: use the original context")
    expect(secondBulkContent).not.toContain("Bulk section one")
    expect(secondBulkContent).not.toContain("bulk-result.json")
    expect(secondBulkContent).not.toContain("Saved bulk-result.json.")
    expect(await listApiVaultConversations(install)).toMatchObject([{ id: seed.threadId, turnCount: 1 }])
  })

  it("saves an image-generation response in the selected result folder", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-image-install-"))
    const output = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-image-output-"))
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "image-1", model: "image-model", data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/B2kAAAAASUVORK5CYII=" }],
    }), { status: 200, headers: { "content-type": "application/json" } })))
    const request: ApiVaultRequest = {
      provider: "9router", endpoint: "http://localhost:20128/v1", apiKey: "local", model: "image-model",
      reasoning: "default", outputKind: "image", outputDirectory: output,
      executionMode: "prompt", conversationMode: "independent", systemInstruction: "", prompt: "Generate a test image", assets: [],
    }
    const result = await runApiVault(install, request)
    expect(result.files).toHaveLength(1)
    expect((await readFile(result.files[0])).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })
})
