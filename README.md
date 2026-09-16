# Kuntyy AutoPrompt

Standalone Google Flow prompt queue and auto-downloader using local FlowPilot sessions.

## Current status

The v0.1 repository includes the PRD, desktop UI, FlowPilot account/profile discovery, safe profile snapshotting, project discovery/creation, queue lifecycle, native Google Flow settings, result-card download routing, quality fallbacks, and tests. Live selectors are isolated in the Flow adapter because Google Flow may change them.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

Microsoft Edge and an existing FlowPilot Google Flow session are required for a real run.

## Windows release and updates

The GitHub workflow **Release Windows Installer** accepts `patch`, `minor`, or `major`. It verifies the source, bumps `package.json` and `package-lock.json`, builds the x64 NSIS installer, pushes the version commit/tag, and publishes the installer, blockmap, and `latest.yml`.

Packaged builds check for updates 15 seconds after launch. Updates are downloaded only after user confirmation in the in-app Updates menu and installed through `quitAndInstall`, preserving application data.

The configured GitHub updater feed is `bisrib613/kuntyyflwprmpt`. It must provide publicly readable releases. Do not embed a GitHub personal access token in the desktop application to access private releases; use a public release repository or a separately authenticated update service instead. Detailed patch notes live inside the application's Updates panel rather than GitHub release notes.

See [PRD](docs/PRD.md) and [Architecture](docs/ARCHITECTURE.md).
