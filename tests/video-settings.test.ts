import { describe, expect, it } from "vitest"
import { supportedVideoDurations, videoSettingsError } from "../src/shared/video-settings"

describe("Google Flow video settings", () => {
  it("exposes native model durations", () => {
    expect(supportedVideoDurations("Omni 1.1 Flash", false)).toEqual([4, 6, 8, 10])
    expect(supportedVideoDurations("Veo 3.1 Fast", false)).toEqual([4, 6, 8])
  })

  it("limits Veo ingredient runs to supported combinations", () => {
    expect(supportedVideoDurations("Veo 3.1 Lite", true)).toEqual([8])
    expect(videoSettingsError("Veo 3.1 Lite", 6, true)).toMatch(/does not support 6s/)
    expect(videoSettingsError("Veo 3.1 Quality", 8, true)).toMatch(/does not support ingredient assets/)
    expect(videoSettingsError("Veo 3.1 Fast", 8, true)).toBeNull()
  })
})
