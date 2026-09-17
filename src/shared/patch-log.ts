export interface PatchLogEntry {
  version: string
  title: string
  items: string[]
}

export const NEXT_UPDATE_PATCHES = [
  "Prevented an unavailable automation runtime from closing the application during startup.",
  "Added a local startup diagnostic log and an installed-app smoke test to Windows CI.",
  "Application name changed to Kuntyy AutoPrompt.",
  "Update channel and release metadata now use a low-profile repository identity.",
  "Detailed patch notes moved from GitHub releases into the application.",
  "Reduced the Windows installer by removing unused runtime languages and duplicate renderer dependencies.",
]

export const PATCH_LOG: PatchLogEntry[] = [
  {
    version: "0.1.0",
    title: "Initial beta",
    items: [
      "Run single prompts, multiple prompt jobs, or prompts imported from a TXT file.",
      "Reuse global assets across jobs and add separate assets to individual jobs.",
      "Reuse local FlowPilot Google sessions through an isolated working snapshot.",
      "Select an existing Flow project or create a new project for a run.",
      "Generate up to three variants and automatically download results as they finish.",
      "Check, download, and install application updates without uninstalling first.",
    ],
  },
]
