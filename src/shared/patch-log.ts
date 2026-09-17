export interface PatchLogEntry {
  version: string
  title: string
  items: string[]
}

export const NEXT_UPDATE_PATCHES = [
  "Write persistent automation.log and crash.log files under the application LocalAppData logs folder.",
  "Record session export, Chrome launch, navigation, project routing, queue phases, and failures without logging cookies or prompt contents.",
  "Stop waiting after 30 seconds when FlowPilot session preparation does not return.",
  "Start Google Flow sessions automatically when Run queue is pressed; manual Connect is no longer required.",
  "Route runs directly through the first recent project or the native Create project action.",
  "Group multiple prompts with an explicit --- separator while preserving paragraph breaks inside each prompt.",
  "Use compact per-job assets and share individual assets across jobs without uploading them again.",
  "Added Google Flow, Docs, and Settings navigation without placeholder API features.",
  "Create a minimal cookie-only FlowPilot session snapshot instead of copying the complete WebView2 profile.",
  "Prevent Windows Terminal from opening alongside the desktop application.",
  "Retry transient GitHub release download errors and refresh updater metadata between attempts.",
  "Publish releases as drafts until all updater assets have uploaded successfully.",
  "Transfer signed-in Google cookies from a native WebView2 snapshot into the Chrome automation context.",
  "Clean temporary session snapshots after cookie export and temporary Chrome profiles when automation closes.",
  "Use the user's installed Node.js runtime instead of bundling a duplicate executable.",
  "Normalized Windows resource paths before starting the automation sidecar.",
  "Require Windows CI to verify that the installed automation runtime becomes ready.",
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
