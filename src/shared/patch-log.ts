export interface PatchLogEntry {
  version: string
  title: string
  items: string[]
}

export const NEXT_UPDATE_PATCHES = [
  "Run Playwright automation inside the selected FlowPilot WebView2 session instead of copying cookies into a separate Chrome profile.",
  "Preserve the complete FlowPilot login state, including browser storage and service-worker state that cookie-only transfer omitted.",
  "Open the selected Google Flow account automatically when the queue starts; no separate Connect action is required.",
  "Use a token-protected localhost bridge between FlowPilot and AutoPrompt without logging session data or prompt contents.",
  "Remove obsolete cookie snapshots, cookie injection, temporary Chrome profiles, and local Chrome launch code.",
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
