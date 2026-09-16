import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { listFlowpilotAccounts } from "../src/main/session/flowpilot"

describe("FlowPilot account discovery", () => {
  it("returns only Flow accounts with valid local profiles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoprompt-test-"))
    await mkdir(path.join(root, "webview-profiles", "flow-safe_id"), { recursive: true })
    await writeFile(path.join(root, "accounts.json"), JSON.stringify([
      { id: "safe_id", name: "Primary", email: "owner@example.test", service: "flow" },
      { id: "chat", name: "ChatGPT", email: null, service: "chatgpt" },
      { id: "../escape", name: "Bad", email: null, service: "flow" },
      { id: "missing", name: "Missing profile", email: null, service: "flow" }
    ]))
    const accounts = await listFlowpilotAccounts(root)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ id: "safe_id", name: "Primary" })
  })
})
