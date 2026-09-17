# Architecture

## Process boundaries

- **Tauri host:** owns native dialogs, updater verification, sidecar lifecycle, and the authenticated localhost bridge.
- **Node sidecar:** owns FlowPilot profile discovery, session snapshotting, Playwright, queue lifecycle, and downloads.
- **React renderer:** configuration and queue UI only.
- **Flow adapter:** contains every Google Flow selector and behavior. UI components never query Flow DOM directly.

The host creates a random 256-bit token for each launch, passes it to the child process, and accepts sidecar responses only over loopback with bearer authentication. The renderer cannot choose a binary or arbitrary command to execute.

## Session snapshot

FlowPilot stores accounts at the Tauri local-data directory for `com.flowpilot.desktop` and service profiles under `webview-profiles/flow-{accountId}`. AutoPrompt validates the account ID, reads account metadata, copies the selected profile to its own temporary user-data directory, then launches installed Google Chrome with that copy.

This is deliberately a snapshot rather than shared live profile access. Chromium profile databases are not safe for simultaneous writes by two applications. However, a WebView2 profile and a Chrome profile must not be assumed to have interchangeable encrypted authentication state merely because their files look similar. Live Windows validation with a real FlowPilot account is a release gate. If that validation fails, session sync must move to an explicit FlowPilot companion handoff; the tool must never report a copied-but-signed-out profile as synchronized.

## Automation state machine

`idle → connecting → ready → submitting → generating → downloading → completed`

Failures are attached to the smallest scope possible. One variant download may fail without erasing files from completed variants. Account/session/project failures stop submission because continuing could target the wrong identity or project.

The authenticated application entry point is `https://labs.google/fx/tools/flow`. The public `flow.google.com/about` marketing route is treated as signed out and is never used for project discovery.

## Selector policy

Prefer observed accessible labels and roles:

- Prompt: `div[contenteditable=true]`
- Submit: `button[aria-label='Start generation']`
- Settings: `button[aria-label='Settings trigger']`
- Asset picker: `button[aria-label='Add ingredients to the prompt box']`
- Result action: `button[aria-label='More options']`
- Native download: menu item `Download`, followed by the requested quality menu item.

Selectors live in one adapter and throw descriptive errors. No coordinate clicking is used in production automation.

## Download routing

Original image URLs are short-lived and are used immediately through the authenticated Playwright context. They are never persisted. Upscaled images and all video formats use native Flow menu actions and Playwright's download event.

## Asset identity

The Flow asset picker does not expose a stable asset ID on its option button. It does expose a unique thumbnail source. Global assets are therefore uploaded one at a time before queue submission and registered by their newly appearing thumbnail identity. Signed query parameters are removed only for `flow-content.google` URLs; other thumbnail URLs are retained for the lifetime of the run. Subsequent jobs reselect the registered option instead of uploading the file again. Display filenames are never used as identity.

## Packaging

Tauri supplies the desktop shell and Windows NSIS setup wizard. The package includes the compiled `playwright-core` sidecar, but no Node runtime, Chromium, ChromeDriver, Electron, or browser cache. The host uses Node.js 20 or newer from the user's `PATH`, and Playwright launches the user's installed Chrome through its supported `chrome` channel.

The release verifier rejects an installer at or above 50 MiB and rejects unsigned updater artifacts. This is a build invariant, not an informal target.

## Update channel

Tauri Updater reads `latest.json` from GitHub Releases. Checking is single-flight and time-bounded. Download and installation are separate user actions; the signed installer is verified against the public key compiled into the app before installation. On Windows, installation hands lifecycle control to the updater and restarts the application. The private signing key exists only in GitHub Actions secrets.

GitHub Actions runs on `windows-latest` with Node 24 and stable Rust. A manual patch/minor/major release verifies tests, bumps the JavaScript, Rust, and Tauri manifests, builds signed NSIS artifacts, enforces the size gate, pushes the version commit and tag, then creates the release with the setup executable, signature, and `latest.json`.

Public GitHub release assets are required by this configuration. A private source repository must publish update artifacts through a public release repository or an authenticated update service; a reusable GitHub token must never be embedded in the client.
