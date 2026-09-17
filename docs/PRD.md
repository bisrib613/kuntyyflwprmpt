# Kuntyy AutoPrompt — Product Requirements Document

## 1. Product goal

Build a standalone Windows desktop tool that submits single or bulk prompts to authenticated Google Flow projects, reuses selected assets, watches every requested variant independently, and automatically downloads completed outputs. Google login sessions come from local FlowPilot profiles so the user does not sign in again.

The application is a new product and repository. It does not change the released FlowPilot 1.5.3 feature set.

## 2. Non-goals for v0.1

- No local image or video upscaler.
- No credential, password, OTP, or cookie upload to a server.
- No project override per job.
- No dependency on asset filenames after upload.
- No hidden API reverse engineering when the visible Flow UI provides the required operation.
- No fourth variant even when Google Flow exposes x4.

## 3. Primary workflow

1. Load Google Flow accounts from FlowPilot's local `accounts.json`.
2. Copy the selected `webview-profiles/flow-{accountId}` into an isolated automation snapshot.
3. Launch the user's installed Google Chrome through a Playwright persistent context using that snapshot.
4. List existing Flow projects.
5. The user selects an existing project or creates one new project for the run.
6. The user configures output type, model, aspect ratio, variants (1–3), quality, assets, prompts, and auto-download.
7. Prompts can be entered in one job, separated from a TXT file, or added with `Add job`.
8. Submit jobs serially; completed variants are downloaded independently while other generations continue.
9. Report explicit per-job and per-variant state. Never silently skip a failed download.

## 4. Jobs and assets

Global assets are uploaded once for the run and applied to every job whose `Use global assets` switch is enabled. Each job may additionally contain its own assets.

The application keeps local asset IDs and paths. It must not infer identity from the filename displayed by Google Flow: pasted files may be named `image.png`, and duplicate display names are valid.

Bulk does not require `Add job`. TXT import creates jobs using either a line containing `---` or a blank-line separator. `Add job` remains available when individual prompts or asset combinations differ.

## 5. Project behavior

- Project is global for a run.
- Existing projects are referenced by project UUID, never by display name alone.
- `New project` creates exactly one project before queue submission.
- Remember the last project per FlowPilot account.
- If the project no longer exists, stop before submitting prompts and request a new selection.

## 6. Generation settings

### Image

- Models discovered in the current UI: Nano Banana Pro, Nano Banana 2, Nano Banana 2 Lite.
- Ratios: 16:9, 4:3, 1:1, 3:4, 9:16.
- Variants exposed by this tool: 1, 2, or 3.

### Video

- Models discovered in the current UI: Omni 1.1 Flash, Veo 3.1 Lite, Veo 3.1 Fast, Veo 3.1 Quality.
- Ratios: 16:9 and 9:16.
- Other settings supported by Flow include resolution and duration; v0.1 keeps them in the adapter contract and exposes them after live selector validation.
- Variants exposed by this tool: 1, 2, or 3.

## 7. Download rules

The card's three-dot menu is the primary native Flow download route. The tool does not open each result detail page.

| Output | Requested quality | Route |
|---|---|---|
| Image | Original 1K | Direct authenticated fetch from the result image `currentSrc` |
| Image | 2K | Card `⋮` → Download → 2K Upscaled |
| Image | 4K | Card `⋮` → Download → 4K; fallback to 2K when unavailable |
| Video | 720p | Card `⋮` → Download → 720p Original |
| Video | 1080p | Card `⋮` → Download → 1080p; fallback to 720p |
| Video | 4K | Card `⋮` → Download → 4K; fallback to 1080p, then 720p |
| Video | GIF | Card `⋮` → Download → 270p Animated GIF |

Google Flow performs every upscale. Disabled or missing native menu items are capability signals, not errors to bypass.

## 8. Queue and concurrency

- Submit one prompt at a time per account to avoid focus and settings collisions.
- Track up to three variants per job independently.
- Generation polling must not block downloads for an already completed variant. New cards are identified by media ID or unique thumbnail identity, not by grid position.
- Default maximum concurrent downloads: two.
- A job is complete only when all expected variants are downloaded or explicitly failed.
- Cancellation stops new submissions and preserves completed files.

## 9. Session and privacy requirements

- Read only Flow service accounts.
- Validate account IDs before resolving paths.
- Copy the profile into the application's own local data before automation.
- Never log cookies, authorization headers, signed media URLs, or profile database contents.
- Never upload session data.
- Do not mutate or delete the original FlowPilot profile.
- If snapshotting fails because FlowPilot is using a locked database, display an actionable error instead of force-copying or corrupting the profile.

## 10. Acceptance criteria

- The UI can load FlowPilot accounts and expose account/project selection.
- Single prompt and TXT bulk both produce valid queue jobs.
- Global assets and per-job assets are represented separately.
- Variant input cannot exceed three.
- Image 4K visibly falls back to 2K when 4K is disabled/missing.
- Video 4K visibly falls back to 1080p then 720p.
- The primary download workflow uses the result-card three-dot menu.
- Original image download does not open the card or menu.
- Each downloaded filename includes run, job, and variant identity to prevent overwrites.
- Typecheck, unit tests, and production renderer build pass.
- A live Windows test proves that the selected FlowPilot account opens Flow without another login. A copied profile that redirects to Google sign-in fails this acceptance criterion.

## 11. Installation and updates

- Windows distribution is an x64 NSIS `.exe` installer.
- Installing a new version upgrades the existing per-user installation without requiring manual uninstall.
- Packaged builds check the configured GitHub Releases feed after startup.
- The Updates menu shows installed and available versions, download progress, errors, and `Restart and install`.
- Update artifacts include the NSIS installer, its Tauri signature, and `latest.json`.
- The release workflow rejects installers at or above 50 MiB.
- The release workflow verifies the source before bumping and publishing a patch, minor, or major version.
- Local sessions and downloaded media are not removed by install/update. Uninstall also keeps application data unless a future explicit user-facing removal option is added.
