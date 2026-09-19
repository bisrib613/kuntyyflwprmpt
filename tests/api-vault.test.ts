import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { routedModel, type ApiVaultRequest } from "../src/shared/api-vault"
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

describe("API Vault agent loop", () => {
  afterEach(() => vi.unstubAllGlobals())

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

  it("saves an image-generation response in the selected result folder", async () => {
    const install = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-image-install-"))
    const output = await mkdtemp(path.join(os.tmpdir(), "kuntyy-vault-image-output-"))
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "image-1", model: "image-model", data: [{ b64_json: Buffer.from("test-image").toString("base64") }],
    }), { status: 200, headers: { "content-type": "application/json" } })))
    const request: ApiVaultRequest = {
      provider: "9router", endpoint: "http://localhost:20128/v1", apiKey: "local", model: "image-model",
      reasoning: "default", outputKind: "image", outputDirectory: output,
      executionMode: "prompt", conversationMode: "independent", systemInstruction: "", prompt: "Generate a test image", assets: [],
    }
    const result = await runApiVault(install, request)
    expect(result.files).toHaveLength(1)
    expect(await readFile(result.files[0], "utf8")).toBe("test-image")
  })
})
