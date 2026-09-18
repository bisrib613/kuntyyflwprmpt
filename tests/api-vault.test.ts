import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { routedModel, type ApiVaultRequest } from "../src/shared/api-vault"
import { createToolContext, executeFilesystemTool, resolveToolPath } from "../src/sidecar/api-vault/filesystem"
import { runApiVault } from "../src/sidecar/api-vault/runner"

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
