export const flowSelectors = {
  prompt: 'div[contenteditable="true"]',
  startGeneration: 'button[aria-label="Start generation"]',
  settings: 'button[aria-label="Settings trigger"]',
  settingsOverlay: ".cdk-overlay-connected-position-bounding-box:visible",
  settingsBackdrop: ".settings-menu-backdrop.cdk-overlay-backdrop-showing",
  assetPicker: 'button[aria-label="Add ingredients to the prompt box"]',
  assetPickerBackdrop: ".cdk-overlay-backdrop.cdk-overlay-dark-backdrop.cdk-overlay-backdrop-showing",
  recentProject: 'a[aria-label="Open project"]',
  resultTile: "flow-grid-tile-container",
  moreOptions: 'button[aria-label="More options"]',
} as const
