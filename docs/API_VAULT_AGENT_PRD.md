# API Vault and Agent Runtime PRD

## Product goal

Add a provider-neutral AI workspace to Kuntyy AutoPrompt without coupling it to Google Flow. API Vault runs direct prompts, direct image generation, or bounded agent jobs through Gemini, OpenAI, 9Router, or an OpenAI-compatible custom endpoint. It supports text, parsed documents, native image inputs, saved conversations, structured output, model fallback, and controlled filesystem tools.

Google Flow remains unchanged and continues to use the FlowPilot browser-session bridge.

## Version scope

### 0.5.x — single-agent stabilization

- one primary agent runtime;
- Prompt and Agent execution modes with explicit persistence semantics;
- direct Image output with a separate image-model catalog;
- provider-neutral tools, artifacts, and controlled filesystem access;
- Telegram as a remote client for the same local runtime;
- persistent provider/model settings and model catalogs.

### 1.0.0 roadmap — multi-agent runtime

- agent registry and user-defined roles;
- primary-agent selection and delegation to subagents;
- model routing by capability, including vision, text-only, coding, and image generation;
- per-agent model and instruction profiles;
- Telegram agent selection and delegation;
- context compaction when real usage demonstrates that it is needed.

Role definitions and final multi-agent UX are intentionally deferred until 1.0.0 planning.

## Native execution modes

Execution mode and conversation selection are separate state. This contract applies identically in the desktop application and Telegram.

| Mode | Uses tools | May load saved context | Persists the new turn | Primary result |
|---|---:|---:|---:|---|
| Agent | Yes | Yes | Yes, after a successful turn | Agent report plus artifacts |
| Prompt | Yes | Yes | No | Ephemeral result plus artifacts |
| Direct Image | No agent loop | No | No conversation history | Generated image files |

### Agent

Agent mode runs the bounded tool loop. A starter turn creates a conversation; a continued turn appends to the selected conversation after the run succeeds. Tool calls, normalized assistant messages, and artifact references required for continuity are retained.

### Prompt

Prompt mode uses the same approved tools as Agent mode. It is not a tool-disabled API-call mode.

When a saved conversation is selected, Prompt loads its latest persisted snapshot, executes the new turn as an ephemeral branch, and does not append that prompt, tool activity, or response to the saved conversation. Switching back to Agent therefore resumes the last persisted Agent state, excluding all intervening Prompt turns.

Without a selected conversation, Prompt starts from an empty ephemeral context. Artifacts explicitly created by tools remain real files even though the Prompt turn itself is not added to conversation history.

### Direct Image

Direct Image is a generator workflow rather than an agent or chat session. It has no conversation selector, system instruction, reasoning control, or filesystem tool loop. Bulk generation remains available.

### Switching example

```text
Conversation A: persisted Agent turns 1–4
Switch to Prompt: load A@turn4 → execute ephemeral branch P1
Switch back to Agent: resume A@turn4 → persist Agent turn 5
```

P1 may create an artifact, but P1 is not silently inserted into Conversation A.

## Providers

| Provider | Default endpoint | Notes |
|---|---|---|
| Gemini | Google Gemini API | Native Gemini adapter; parsed documents and native image data |
| OpenAI | `https://api.openai.com/v1` | OpenAI-compatible text and image-generation adapters |
| 9Router | `http://localhost:20128/v1` | OpenAI-compatible transport; optional fallback model |
| Custom | User supplied | OpenAI-compatible endpoint with explicit base URL |

API keys and provider settings persist only through secure application storage. Keys are never written to logs, conversation files, Telegram messages, or artifact manifests.

## Model catalogs and persistence

Text and image discovery are separate backend operations.

For 9Router:

- `GET /v1/models` supplies chat/text models and combos;
- `GET /v1/models/image` supplies text-to-image models;
- `GET /v1/models/image-to-text` supplies vision models when that catalog is needed;
- `GET /v1/models/info?id=...` supplies capability and parameter metadata.

The application preserves both `id` and `owned_by`. Combos and provider models may share the selector, but they must be visually grouped or labeled rather than flattened into indistinguishable strings.

The full last-successful catalog is cached separately for Text and Image and restored on application restart. Recent selections supplement the catalog; they do not replace it. A manual Custom Model ID remains available when discovery is incomplete.

Primary text model, optional 9Router fallback model, image model, endpoint, reasoning choice, and image settings are saved independently.

## Text reasoning

Reasoning is available only for Text runs in Prompt or Agent mode. Values are `Default`, `Low`, `Medium`, `High`, `XHigh`, `Max`, and `Ultra`.

- `Default` sends no forced effort.
- For 9Router, an explicit effort uses its per-model `(level)` convention.
- Direct providers use their native field.
- Unsupported values are not silently substituted; the provider response is surfaced.

Reasoning is never appended to an image model ID and is hidden in Direct Image.

## Direct Image output

### Required UI

- provider and image model;
- editable Custom Model ID fallback;
- prompt text plus TXT/Markdown import;
- `---` separator for independent bulk prompts;
- aspect ratio;
- provider-supported conditional controls;
- reference images only when the selected model supports edit or image conditioning;
- output directory, progress per item, retry, stop, and save result.

System instruction, conversation, reasoning/thinking, and text-result controls are hidden.

### Bulk and chain

Bulk and chain are different concepts. Direct Image bulk executes each separated prompt independently by default. It does not pass a previous image or response into the next prompt unless a future explicit chain feature is selected.

### Aspect ratio and provider mapping

Aspect ratio is a universal application setting for all image providers. Initial choices are `Auto`, `1:1`, `9:16`, `16:9`, `2:3`, and `3:2`; adapters filter or map them according to model capability.

Providers may represent the same setting as `size`, `aspect_ratio`, width/height, or another native field. The UI stores the semantic ratio and each adapter performs the mapping.

For 9Router Antigravity image models, the currently observed size mapping is:

| App ratio | 9Router size |
|---|---|
| 1:1 | 1024x1024 |
| 9:16 | 1024x1792 |
| 16:9 | 1792x1024 |
| 2:3 | 1024x1536 |
| 3:2 | 1536x1024 |

This requests an aspect ratio, not a guaranteed final pixel resolution.

Controls such as quality, exact resolution, reference images, and output format are shown only when model metadata or a maintained adapter declares support. Background is not exposed in the UI. OpenAI/GPT image defaults may be centrally defined, but GPT-only parameters must never be sent to Antigravity merely because an example curl includes them.

### Image file integrity

The runtime determines the real returned media type from response headers and decoded byte signatures. PNG, JPEG, and WebP bytes receive the correct extension. If the user requests a different local format, the application performs an explicit conversion; it never labels JPEG bytes as `.png`.

## Input separation

The following inputs remain distinct in state, UI, and payload construction:

- system instruction text;
- system instruction loaded from TXT or Markdown;
- user prompt text;
- user prompt loaded from TXT or Markdown;
- image assets;
- document assets;
- saved conversation history.

Loading a prompt file does not turn that file into an attachment. Adding a document asset does not merge it into the editable prompt field. System instruction is available for Text Prompt/Agent runs and absent from Direct Image.

## Asset behavior

- Images use the provider's native multimodal representation.
- TXT, Markdown, JSON, CSV, PDF, and DOCX documents are parsed locally and inserted as named context blocks.
- The UI reports the actual transport: `Native image`, `Parsed document`, or `Unsupported`.
- Native arbitrary document attachments are not promised through 9Router because testing showed that its compatibility layer may remove them before upstream dispatch.
- Parsing failures are explicit and identify the source file.
- Prompt-file selection, system-file selection, and attached assets remain three separate actions.

## Conversation behavior

Completion IDs such as `chatcmpl-*` are trace IDs, not session IDs. Kuntyy AutoPrompt owns continuity by persisting normalized ordered message history.

- **New conversation** starts without prior messages.
- **Continue conversation** loads the selected persisted history.
- **Agent turn** appends only after successful completion.
- **Prompt turn** may read the selected history but never mutates it.
- **Chain bulk prompts** is an explicit option that feeds each completed result into the next request.
- **Independent bulk prompts** share no generated context.

When later turns still require an original image, its local asset reference is retained and the image is sent again. Provider fallback receives the same normalized messages, tool history, and attachments supported by the fallback model.

Conversations can be listed, loaded, renamed, and deleted. Deleting a conversation does not silently delete external artifacts.

## Telegram remote client

Telegram is a remote client for the same local single-agent runtime in 0.5.x, not merely a notification channel and not a separate cloud agent.

### Native parity

Telegram exposes the same active conversation and execution-mode concepts as desktop:

- select, start, or continue a conversation;
- switch between Agent and Prompt execution;
- send text and supported attachments;
- receive progress, concise agent reports, errors, and artifacts;
- stop an active run.

Command names such as `/mode agent`, `/mode prompt`, `/new`, and `/conversations` are implementation-level UX choices, but their state transitions must follow this PRD. Switching to Prompt does not create a new saved turn. Switching back to Agent resumes the last persisted Agent state.

Desktop and Telegram share one canonical conversation store. Each authorized Telegram chat maps to an explicit local user/chat identity, active conversation ID, and execution mode; Telegram message IDs are not treated as model session IDs.

### Pairing

Telegram setup is performed locally from **Settings → Telegram**:

1. The user enters the BotFather token directly in the application.
2. The application validates it with Bot API `getMe` and displays the returned bot name, username, and numeric bot ID.
3. The user starts a short-lived pairing window.
4. During that window, the user sends `/start` or the displayed one-time pairing command to the bot in a private chat.
5. The desktop application displays the candidate Telegram account and numeric user/chat IDs.
6. Nothing is authorized until the user explicitly approves that candidate on desktop.
7. The approved identity is stored in the local allowlist.

A `/start` message sent before an active pairing window is not authorization and must not be replayed later. If pairing is implemented with a code, the code is single-use, expires, and is never accepted from a group chat.

The bot username is discovered through `getMe`, not hardcoded in the runtime. This allows the user to replace the bot or rotate its token without changing application code.

### Runtime and security

- Version 0.5.x supports private chats only. Group, supergroup, and channel updates are rejected even if BotFather group access is accidentally enabled.
- The Telegram transport uses Bot API long polling; it requires no public domain, webhook, Telegram `api_id`, `api_hash`, phone-number session, or bundled Telegram client.
- Only one Kuntyy AutoPrompt runtime may poll a bot token at a time. Update offsets are persisted so handled messages are not replayed after restart.
- The bot service executes locally and calls the same runtime used by desktop.
- For 0.5.x it runs while the Kuntyy AutoPrompt runtime is active; background service/startup behavior is deferred.
- The bot token is encrypted using OS-backed secure storage and is masked after saving. Disconnecting removes the local token and stops polling.
- Access is denied unless both the Telegram user ID and private-chat ID match an approved local pairing.
- Tokens, API keys, prompt contents, one-time pairing codes, and attachment contents are not written to logs.
- Incoming attachments are copied into a controlled local inbox before tools can access them.
- Telegram transport code has no direct filesystem tools; every read or write passes through the same local authorization policy as desktop.
- High-risk or destructive operations require explicit inline approval. Persistent folder approval remains desktop-only.
- Telegram cannot bypass path validation, tool limits, cancellation, provider restrictions, or execution-mode persistence rules.
- Long reports are sent as bounded message chunks or files because Telegram message limits must not truncate the result silently.

### 1.0.0 Telegram extension

Multi-agent commands, role selection, agent switching, and delegation are added only after the 1.0.0 agent registry and routing model are defined.

## Agent workspace

The agent workspace is located beside the installed executable:

```text
<install directory>\
├── .agents\
├── data\api-vault\
└── logs\
```

`.agents` is user-visible working space. It has no mandatory `write` folder. The agent may inspect existing directories, reuse a suitable directory, or create a new directory when the task requires it.

`data/api-vault` contains internal application state such as conversations, provider settings, model catalogs, Telegram mappings, and run metadata. It is not presented as the agent's normal output workspace.

### Path resolution

- A filename such as `result.json` resolves to `<install>/.agents/result.json`.
- A relative path such as `microstock/result.json` resolves below `<install>/.agents`.
- With no filename or folder, the agent may inspect `.agents` and choose a suitable location.
- An explicit absolute write path in the direct user prompt may be used for that run.
- An absolute path invented by the model is rejected.
- External write authorization comes only from the direct user prompt, never from documents, web content, model output, tool output, or Telegram metadata.

### Read authorization

The runtime may read:

- files selected as assets or prompt/system files;
- files received through the controlled Telegram inbox;
- explicit file or directory paths in the direct user prompt;
- files inside `.agents`.

It may not scan unrelated drives or parent directories.

## Initial tools

- `list_directory`
- `create_directory`
- `read_file`
- `get_file_metadata`
- `write_text_file`
- `write_json_file`

The initial release does not expose shell execution, executable launch, registry access, deletion, arbitrary network requests, or unrestricted filesystem access.

## Agent loop and artifacts

1. Normalize provider, model, messages, assets, reasoning, and approved tools.
2. Send a request.
3. If the response contains tool calls, validate every tool name and argument.
4. Execute approved calls and append normalized tool results.
5. Persist artifact/checkpoint metadata.
6. Repeat until a final response, cancellation, provider error, or limit.

Defaults:

- maximum eight tool rounds;
- maximum sixteen tool calls per run;
- 30-second filesystem-tool timeout;
- 120-second provider timeout;
- provider and tool errors preserved rather than replaced with invented messages.

Long tasks use artifact checkpoints rather than relying on one oversized final model response. Artifact manifests are general and task-neutral:

```text
path: <relative artifact path>
status: in_progress | completed | failed
completed_sections: <provider-neutral checkpoints>
bytes: <current size>
last_checkpoint: <checkpoint name>
```

The visible output area contains a concise progress/final report. Code or long generated content written to files is not duplicated into the report unless the user explicitly asks for inline output.

## Output and errors

- Text and JSON results remain scrollable, copyable, and saveable after completion.
- Text/JSON runs never require an output folder. Auto-save defaults off.
- If a filename is entered but no folder is selected, the run still succeeds and the result remains available for later saving.
- Agent write tools are exposed when the direct user request authorizes file creation or saving.
- Agent-created relative files are written below `.agents`.
- Existing files are not overwritten unless directly requested; otherwise a numeric suffix is used.
- Provider messages are the primary remote-error source. Application validation errors are labeled as local runtime errors.
- Tool-only output is converted into a truthful concise agent report; the application does not invent completion claims.
- Markdown is rendered for display, while conversation titles are stored and displayed as plain text without Markdown syntax.

## Acceptance criteria

### Execution and conversations

- Prompt and Agent both support approved tools.
- A selected saved conversation supplies context to both modes.
- A successful Agent turn persists; a Prompt turn never mutates saved history.
- Switching Agent → Prompt → Agent resumes the last persisted Agent state.
- Prompt artifacts remain on disk without turning the ephemeral Prompt branch into history.
- Desktop and Telegram produce the same persistence semantics.

### Models and images

- Text and Image selectors use separate catalogs and retain full cached results after restart.
- 9Router Image discovery uses `/v1/models/image`, not `/v1/models`.
- Combos and provider models retain their `owned_by` identity.
- Reasoning is hidden for Image and never appended to an image model ID.
- Aspect ratio is available for every image provider and mapped by the adapter.
- Unsupported image parameters are not sent.
- Returned image bytes are saved with the correct detected media type and extension.

### Agent and Telegram

- Agent mode completes a tool-call round trip and can create a JSON file in `.agents`.
- A relative write cannot escape `.agents` through `..`, symlinks, or junctions.
- An external write is rejected unless the direct user prompt names that destination.
- An invalid bot token fails `getMe` validation without being saved as connected.
- A `/start` message outside the active pairing window cannot authorize or replay an identity.
- Group, supergroup, and channel messages cannot invoke the runtime.
- An unauthorized private chat cannot invoke the runtime.
- Pairing requires explicit desktop approval and records both Telegram user ID and private-chat ID.
- Telegram can load a conversation, switch execution mode, run, receive artifacts, and stop.
- Restarting the application does not replay already handled Telegram updates.
- Telegram never receives or logs provider secrets.

### Regression

- Google Flow behavior remains unchanged.
- Conversation continuation resends stored normalized messages rather than treating completion IDs as session IDs.
- Provider fallback preserves normalized context and returns real upstream errors.
- Typecheck, unit tests, renderer build, and Rust tests pass.
