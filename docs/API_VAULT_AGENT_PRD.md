# API Vault and Agent Runtime PRD

## Product goal

Add a provider-neutral AI workspace to Kuntyy AutoPrompt without coupling it to Google Flow. API Vault runs direct prompts or multi-step agent jobs through Gemini, OpenAI, 9Router, or an OpenAI-compatible custom endpoint. It supports text, parsed documents, native image inputs, conversation threads, structured output, model fallback, and bounded filesystem tools.

Google Flow remains unchanged and continues to use the FlowPilot browser session bridge.

## Navigation and execution modes

The application exposes a top-level **API Vault** tab beside Google Flow.

- **Prompt**: one model request produces one response. No tool loop runs.
- **Agent**: the model may request tools. The runtime validates and executes each request, appends the tool result, and calls the model again until it returns a final response or reaches a limit.

Bulk prompts default to independent context. A user may explicitly enter a saved local thread ID or chain bulk prompts sequentially.

## Providers

| Provider | Default endpoint | Notes |
|---|---|---|
| Gemini | Google Gemini API | Native Gemini adapter; parsed documents and native image data |
| OpenAI | `https://api.openai.com/v1` | OpenAI-compatible chat and image-generation adapters |
| 9Router | `http://localhost:20128/v1` | OpenAI-compatible chat transport; optional fallback model |
| Custom | User supplied | OpenAI-compatible endpoint with explicit base URL |

Secrets are kept in memory for the run unless the user later opts into secure OS credential storage. They are never written to logs or conversation files.

## Models and reasoning

Model IDs remain user-selectable and editable. The reasoning control is a dropdown, not a free-text field.

Possible values are `Default`, `Low`, `Medium`, `High`, `XHigh`, `Max`, and `Ultra`. Unsupported values must not be silently substituted by the application; the provider's actual error is shown.

For 9Router, the adapter uses its documented per-model thinking-level convention by appending `(level)` to the routed model ID. 9Router removes the suffix before upstream dispatch and translates the requested effort for the selected provider. The unsuffixed model is used for `Default`.

For direct providers, adapters use the provider's native reasoning field. A raw provider error is surfaced when a selected model rejects a level.

## Input separation

The following inputs remain distinct in state, UI, and provider payload construction:

- system instruction text;
- system instruction loaded from TXT or Markdown;
- user prompt text;
- user prompt loaded from TXT or Markdown;
- image assets;
- document assets;
- conversation history.

Loading a prompt file does not turn that file into an attachment. Adding a document asset does not merge it into the editable prompt field.

## Asset behavior

- Images use the provider's native multimodal representation.
- TXT, Markdown, JSON, CSV, PDF, and DOCX documents are parsed locally and inserted as named document context blocks.
- The UI reports the actual transport: `Native image`, `Parsed document`, or `Unsupported`.
- Native arbitrary document attachments are not promised through 9Router because current testing showed that its capability layer may remove them before upstream dispatch.
- Parsing failures are explicit and identify the source file.

## Conversation behavior

Chat-completion IDs such as `chatcmpl-*` are trace IDs, not session IDs. The application owns conversation continuity by persisting the ordered message history.

- **Independent** starts with no prior messages.
- **Continue thread** loads a selected local thread.
- **Chain bulk prompts** appends every completed prompt and response in order.

When later turns still require the original image, its local asset reference is retained and the image is sent again. Provider fallback receives the same normalized message and tool history.

## Agent workspace

The agent workspace is located beside the installed executable:

```text
<install directory>\
├── .agents\
├── data\api-vault\
└── logs\
```

`.agents` is user-visible working space. It has no mandatory `write` folder. The agent may inspect existing directories, reuse a suitable directory, or create a new directory when the task requires it.

`data/api-vault` contains internal application state such as conversations and run metadata. It is not presented as the agent's normal output workspace.

### Path resolution

- A filename such as `result.json` resolves to `<install>/.agents/result.json`.
- A relative path such as `microstock/result.json` resolves below `<install>/.agents`.
- With no filename or folder, the agent may inspect `.agents` and choose a suitable existing or new location.
- An explicit absolute write path in the direct user prompt may be used for that run.
- An absolute path invented by the model is rejected.
- External write authorization comes only from the direct user prompt, never from document contents, web content, model output, or tool output.

### Read authorization

The runtime may read:

- files selected by the user as assets or prompt/system files;
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

## Agent loop and limits

1. Normalize provider, model, messages, assets, reasoning, and tools.
2. Send a request.
3. If the response contains tool calls, validate every tool name and argument.
4. Execute approved calls and append results in provider-neutral history.
5. Repeat until a final response, cancellation, provider error, or limit.

Defaults:

- maximum eight tool rounds;
- maximum sixteen tool calls per run;
- 30-second filesystem tool timeout;
- 120-second provider timeout;
- tool and provider errors preserved rather than replaced with invented messages.

## Output and errors

- Text and JSON responses are displayed and may be saved.
- Image output uses the provider's image-generation route and requires a separately selected result directory.
- Agent-created relative files are written below `.agents`.
- Existing files are not overwritten unless the direct user instruction requests replacement; otherwise a numeric suffix is used.
- Provider response messages are the primary error source. Application-generated validation errors are clearly labeled as local runtime errors.

## Acceptance criteria

- API Vault is a real top-level tab; Google Flow behavior remains unchanged.
- Provider, endpoint, API key, primary model, optional 9Router fallback model, and reasoning are configurable.
- Reasoning `Default` sends no forced level; 9Router forced levels use its `(level)` model convention.
- A native image reaches a vision-capable 9Router model through an `image_url` data URL.
- TXT and Markdown files are parsed without pretending they were native provider attachments.
- Prompt and Agent modes have observably different behavior.
- Agent mode completes a tool-call round trip and can create a JSON file in `.agents`.
- A relative write cannot escape `.agents` with `..`, symlinks, or junctions.
- An external write is rejected unless the direct user prompt explicitly names that destination.
- Conversation continuation resends stored messages rather than treating `chatcmpl-*` as a session identifier.
- Typecheck, unit tests, renderer build, and Rust tests pass.
