# Kuntyy AutoPrompt

Lightweight Google Flow prompt queue and auto-downloader using the original local FlowPilot session.

## Current status

The repository includes the desktop UI, direct FlowPilot WebView2 session attachment, project discovery/creation, single and bulk queues, per-job and global assets, native Google Flow settings, result-card download routing, quality fallbacks, and tests. Live selectors are isolated in the Flow adapter because Google Flow may change them.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

An updated, running FlowPilot with an existing Google Flow session is required for a real run. Playwright attaches to that session through Chromium DevTools Protocol. ChromeDriver, a bundled browser, and a second Chrome profile are not used.

## Windows release and updates

The GitHub workflow **Release Windows Installer** accepts `patch`, `minor`, or `major`. It verifies the source, bumps the manifests, packages the Node automation sidecar, builds the x64 NSIS setup wizard, enforces a hard installer limit below 50 MiB, pushes the version commit/tag, and publishes signed Tauri update artifacts plus `latest.json`.

Packaged builds check for updates from the in-app Updates menu. Updates are downloaded only after user confirmation, cryptographically verified by Tauri, installed, and activated on restart.

The configured GitHub updater feed is `bisrib613/kuntyyflwprmpt`. Release assets must be publicly readable. Never embed a GitHub personal access token in the application; use a public release repository or a separately authenticated update service. The release workflow requires `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. Detailed patch notes live inside the application's Updates panel.

See [PRD](docs/PRD.md) and [Architecture](docs/ARCHITECTURE.md).
