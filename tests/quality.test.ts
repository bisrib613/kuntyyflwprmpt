import { describe, expect, it } from "vitest"
import { qualityFallbacks } from "../src/shared/quality"

describe("quality fallbacks", () => {
  it("falls image 4K back to native 2K", () => {
    expect(qualityFallbacks("image", "upscale-4k")).toEqual(["upscale-4k", "upscale-2k"])
  })

  it("falls video 4K back through native 1080p and original 720p", () => {
    expect(qualityFallbacks("video", "upscale-4k")).toEqual(["upscale-4k", "upscale-1080p", "original-720p"])
  })

  it("does not add a fallback to original image downloads", () => {
    expect(qualityFallbacks("image", "original-1k")).toEqual(["original-1k"])
  })
})
