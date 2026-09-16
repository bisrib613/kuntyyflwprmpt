# Architecture

## Process boundaries

- **Electron main:** owns filesystem access, FlowPilot profile discovery, session snapshotting, Playwright, queue lifecycle, and downloads.
- **Preload:** exposes a narrow typed IPC API. No raw Electron or Node object reaches the renderer.
- **React renderer:** configuration and queue UI only.
- **Flow adapter:** contains every Google Flow selector and behavior. UI components never query Flow DOM directly.

## Session snapshot

FlowPilot stores accounts at the Tauri local-data directory for `com.flowpilot.desktop` and service profiles under `webview-profiles/flow-{accountId}`. AutoPrompt validates the account ID, reads account metadata, copies the selected profile to its own user-data directory, then launches installed Microsoft Edge with that copy.

This is deliberately a snapshot rather than shared live profile access. Chromium profile databases are not safe for simultaneous writes by two applications. A later FlowPilot companion protocol may provide coordinated live-session leasing, but it is not required by the v0.1 repository.

## Automation state machine

`idle → connecting → ready → submitting → generating → downloading → completed`

Failures are attached to the smallest scope possible. One variant download may fail without erasing files from completed variants. Account/session/project failures stop submission because continuing could target the wrong identity or project.

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

Electron is used because Playwright runs directly in the main process and can launch the installed Edge browser without a Rust/Node sidecar. The initial Windows bundle uses NSIS.

## Update channel

`electron-updater` reads the GitHub provider configuration generated into the packaged application. Automatic startup checks do not automatically download; the user starts the transfer from the Updates menu. The main process owns checking, downloading, and `quitAndInstall`; the renderer receives typed state only.

GitHub Actions runs on `windows-latest` with Node 24. A manual patch/minor/major release verifies tests, bumps both package manifests, builds NSIS artifacts, pushes the version commit and tag, then creates the release with `.exe`, `.blockmap`, and `latest.yml`.

Public GitHub release assets are required by this configuration. A private source repository must publish update artifacts through a public release repository or an authenticated update service; a reusable GitHub token must never be embedded in the client.
