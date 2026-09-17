export const flowSelectors = {
  prompt: 'div[contenteditable="true"]',
  startGeneration: 'button[aria-label="Start generation"]',
  settings: 'button[aria-label="Settings trigger"]',
  assetPicker: 'button[aria-label="Add ingredients to the prompt box"]',
  recentProject: 'a[aria-label="Open project"]',
  resultTile: "flow-grid-tile-container",
  moreOptions: 'button[aria-label="More options"]',
} as const
