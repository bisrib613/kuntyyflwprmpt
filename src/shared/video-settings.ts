import type { VideoDuration } from "./contracts.js"

const VEO_DURATIONS: VideoDuration[] = [4, 6, 8]
const OMNI_DURATIONS: VideoDuration[] = [4, 6, 8, 10]

export function supportedVideoDurations(model: string, hasAssets: boolean): VideoDuration[] {
  if (/Omni/i.test(model)) return [...OMNI_DURATIONS]
  if (hasAssets && /Veo 3\.1 (?:Lite|Fast)/i.test(model)) return [8]
  return [...VEO_DURATIONS]
}

export function videoSettingsError(model: string, duration: VideoDuration, hasAssets: boolean): string | null {
  if (hasAssets && /Veo 3\.1 Quality/i.test(model)) return "Veo 3.1 Quality does not support ingredient assets. Choose Omni 1.1 Flash, Veo 3.1 Lite, or Veo 3.1 Fast."
  if (!supportedVideoDurations(model, hasAssets).includes(duration)) return `${model} does not support ${duration}s with the current asset setup.`
  return null
}
