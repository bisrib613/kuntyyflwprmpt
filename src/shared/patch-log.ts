export interface PatchLogEntry {
  version: string
  title: string
  items: string[]
}

export const NEXT_UPDATE_PATCHES = [
  "Prevent long API Vault Agent runs from being reported as a dead automation runtime after 30 seconds.",
  "Always show the latest API Vault result, or the provider's real error when a run produces no output.",
  "Read structured assistant text parts returned by OpenAI-compatible providers instead of displaying a blank result.",
  "Add New, Load, and Delete controls for locally saved API Vault conversations.",
  "Remember endpoint, API key, model, fallback model, and reasoning per provider with Windows-protected API keys.",
  "Prevent Google Flow's open asset overlay from blocking the picker trigger during asset reuse.",
  "Add native video-duration controls with model- and ingredient-aware 4s, 6s, 8s, and 10s options.",
  "Keep Text and JSON results in a bounded scrollable panel with Copy and Save result actions.",
  "Allow Text and JSON runs without a selected result folder, even when Auto-save was enabled accidentally.",
  "Save completed Text and JSON responses later without repeating the provider request.",
  "Expose Agent write tools only when the direct user prompt explicitly asks to create or save a file.",
  "Add API Vault with Gemini, OpenAI, 9Router, and custom OpenAI-compatible providers.",
  "Add model, endpoint, API key, reasoning level, and 9Router fallback-model controls.",
  "Keep system instructions, user prompts, prompt files, images, and parsed document assets as separate inputs.",
  "Add independent, continued, and chained local conversation modes without treating provider response IDs as sessions.",
  "Add Prompt and Agent modes with bounded filesystem tools and a default workspace beside the installed app under .agents.",
  "Restrict external reads and writes to user-selected assets or paths explicitly named in the direct prompt.",
  "Add Text / JSON and Image outputs with an explicit image result folder.",
  "Bundle PDF and DOCX parsing into the automation sidecar so installed builds do not require extra packages.",
]

export const PATCH_LOG: PatchLogEntry[] = [
  {
    version: "0.1.0",
    title: "Initial beta",
    items: [
      "Run single prompts, multiple prompt jobs, or prompts imported from a TXT file.",
      "Reuse global assets across jobs and add separate assets to individual jobs.",
      "Reuse local FlowPilot Google sessions for Google Flow automation.",
      "Select an existing Flow project or create a new project for a run.",
      "Generate up to three variants and automatically download results as they finish.",
      "Check, download, and install application updates without uninstalling first.",
    ],
  },
]
