import { describe, expect, it } from "vitest"
import { FLOW_APP_URL, isSignedOutFlowRoute } from "../src/main/automation/flow-route"

describe("Google Flow application routing", () => {
  it("opens the authenticated Flow application instead of the marketing site", () => {
    expect(FLOW_APP_URL).toBe("https://labs.google/fx/tools/flow")
  })

  it("recognizes Google sign-in and the signed-out marketing redirect", () => {
    expect(isSignedOutFlowRoute("https://accounts.google.com/v3/signin/identifier")).toBe(true)
    expect(isSignedOutFlowRoute("https://flow.google.com/about")).toBe(true)
    expect(isSignedOutFlowRoute("https://labs.google/fx/tools/flow")).toBe(false)
  })
})
