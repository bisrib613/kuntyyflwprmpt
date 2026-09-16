import type { DownloadQuality, OutputKind } from "./contracts.js"

export const qualityFallbacks = (output: OutputKind, requested: DownloadQuality): DownloadQuality[] => {
  if (output === "image") {
    if (requested === "upscale-4k") return ["upscale-4k", "upscale-2k"]
    return [requested]
  }
  if (requested === "upscale-4k") return ["upscale-4k", "upscale-1080p", "original-720p"]
  if (requested === "upscale-1080p") return ["upscale-1080p", "original-720p"]
  return [requested]
}

export const qualityMenuLabel: Record<DownloadQuality, RegExp> = {
  "original-1k": /1K\s+Original size/i,
  "upscale-2k": /2K\s+Upscaled/i,
  "upscale-4k": /4K\s+Upscaled/i,
  "original-720p": /720p\s+Original size/i,
  "upscale-1080p": /1080p\s+Upscaled/i,
  "gif-270p": /270p\s+Animated GIF/i,
}
