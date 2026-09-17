export const FLOW_APP_URL = "https://labs.google/fx/tools/flow"

export function isSignedOutFlowRoute(value: string): boolean {
  const url = new URL(value)
  return url.hostname === "accounts.google.com"
    || (url.hostname === "flow.google.com" && url.pathname.startsWith("/about"))
}
