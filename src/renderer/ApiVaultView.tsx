import { useMemo, useState } from "react"
import type { ApiOutputKind, ApiProvider, ApiVaultAsset, ApiVaultResponse, ConversationMode, ReasoningLevel } from "../shared/api-vault"
import { REASONING_LEVELS } from "../shared/api-vault"
import { parsePromptText } from "../shared/prompt-file"

const PROVIDERS: Array<{ value: ApiProvider; label: string; endpoint: string; model: string }> = [
  { value: "gemini", label: "Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
  { value: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", model: "gpt-5" },
  { value: "9router", label: "9Router", endpoint: "http://localhost:20128/v1", model: "ag/gemini-3.6-flash-low" },
  { value: "custom", label: "Custom", endpoint: "http://localhost:8080/v1", model: "" },
]

export function ApiVaultView() {
  const [provider, setProvider] = useState<ApiProvider>("9router")
  const [endpoint, setEndpoint] = useState(PROVIDERS[2].endpoint)
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState(PROVIDERS[2].model)
  const [modelOptions, setModelOptions] = useState([PROVIDERS[2].model])
  const [customModel, setCustomModel] = useState(false)
  const [fallbackModel, setFallbackModel] = useState("")
  const [reasoning, setReasoning] = useState<ReasoningLevel>("default")
  const [executionMode, setExecutionMode] = useState<"prompt" | "agent">("prompt")
  const [outputKind, setOutputKind] = useState<ApiOutputKind>("text")
  const [outputDirectory, setOutputDirectory] = useState("")
  const [conversationMode, setConversationMode] = useState<ConversationMode>("independent")
  const [threadId, setThreadId] = useState("")
  const [systemInstruction, setSystemInstruction] = useState("")
  const [prompt, setPrompt] = useState("")
  const [assets, setAssets] = useState<ApiVaultAsset[]>([])
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState("Configure a provider and enter a prompt.")
  const [responses, setResponses] = useState<ApiVaultResponse[]>([])
  const prompts = useMemo(() => parsePromptText(prompt), [prompt])

  const changeProvider = (value: ApiProvider) => {
    const preset = PROVIDERS.find((candidate) => candidate.value === value)!
    setProvider(value); setEndpoint(preset.endpoint); setModel(preset.model); setModelOptions(preset.model ? [preset.model] : []); setCustomModel(!preset.model); setFallbackModel("")
  }

  const refreshModels = async () => {
    setStatus("Loading provider models…")
    const result = await window.autoPrompt.listApiVaultModels(provider, endpoint, apiKey)
    if (!result.ok) return setStatus(result.error)
    setModelOptions(result.value)
    if (result.value.length && !result.value.includes(model)) { setModel(result.value[0]); setCustomModel(false) }
    setStatus(`Loaded ${result.value.length} model${result.value.length === 1 ? "" : "s"}.`)
  }

  const loadText = async (target: "system" | "prompt") => {
    const result = await window.autoPrompt.pickApiVaultTextFile()
    if (!result.ok) return setStatus(result.error)
    if (!result.value) return
    if (target === "system") setSystemInstruction(result.value.text)
    else setPrompt(result.value.text)
    setStatus(`Loaded ${result.value.name}.`)
  }

  const addAssets = async () => {
    const result = await window.autoPrompt.pickApiVaultAssets()
    if (!result.ok) return setStatus(result.error)
    setAssets((current) => [...current, ...result.value])
  }

  const chooseOutputDirectory = async () => {
    const result = await window.autoPrompt.pickDownloadDirectory()
    if (!result.ok) return setStatus(result.error)
    if (result.value) setOutputDirectory(result.value)
  }

  const run = async () => {
    if (!endpoint.trim() || !model.trim() || !prompts.length) return
    setRunning(true); setResponses([])
    let activeThreadId: string | undefined = conversationMode === "continue" ? threadId.trim() || undefined : undefined
    const collected: ApiVaultResponse[] = []
    try {
      for (let index = 0; index < prompts.length; index += 1) {
        setStatus(`Running prompt ${index + 1} of ${prompts.length}…`)
        const result = await window.autoPrompt.runApiVault({
          provider, endpoint, apiKey, model, fallbackModel: provider === "9router" ? fallbackModel : undefined,
          reasoning, outputKind, outputDirectory: outputKind === "image" ? outputDirectory : undefined,
          executionMode, conversationMode: conversationMode === "chain" ? "continue" : conversationMode,
          threadId: activeThreadId, systemInstruction, prompt: prompts[index], assets,
        })
        if (!result.ok) throw new Error(result.error)
        activeThreadId = result.value.threadId
        if (activeThreadId) setThreadId(activeThreadId)
        collected.push(result.value)
        setResponses([...collected])
      }
      setStatus(`Completed ${collected.length} prompt${collected.length === 1 ? "" : "s"}.`)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setRunning(false) }
  }

  return <main className="vault-layout">
    <aside className="vault-config">
      <div className="section-heading"><span>01</span><div><h2>Provider</h2><p>Direct API connection</p></div></div>
      <label>Provider<select value={provider} disabled={running} onChange={(event) => changeProvider(event.target.value as ApiProvider)}>{PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label>Base URL<input value={endpoint} disabled={running} onChange={(event) => setEndpoint(event.target.value)} /></label>
      <label>API key<input type="password" autoComplete="off" value={apiKey} disabled={running} onChange={(event) => setApiKey(event.target.value)} placeholder={provider === "9router" ? "Optional when local auth is disabled" : "Required by provider"} /></label>
      <label>Model<div className="model-picker"><select value={customModel ? "__custom__" : model} disabled={running} onChange={(event) => { if (event.target.value === "__custom__") setCustomModel(true); else { setCustomModel(false); setModel(event.target.value) } }}>{modelOptions.map((value) => <option value={value} key={value}>{value}</option>)}<option value="__custom__">Custom model ID…</option></select><button className="secondary" type="button" disabled={running || !endpoint.trim()} onClick={() => void refreshModels()}>Refresh</button></div></label>
      {customModel && <label>Custom model ID<input value={model} disabled={running} onChange={(event) => setModel(event.target.value)} placeholder="Provider model ID" /></label>}
      {provider === "9router" && <label>Fallback model <span className="optional">Optional</span><input list="api-vault-model-options" value={fallbackModel} disabled={running} onChange={(event) => setFallbackModel(event.target.value)} placeholder="Used only after a provider error" /></label>}
      <datalist id="api-vault-model-options">{modelOptions.map((value) => <option value={value} key={value} />)}</datalist>
      <label>Reasoning<select value={reasoning} disabled={running} onChange={(event) => setReasoning(event.target.value as ReasoningLevel)}>{REASONING_LEVELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <p className="field-help">9Router forces reasoning through its model-level suffix. Default leaves model behavior unchanged.</p>
      <div className="section-heading vault-section"><span>02</span><div><h2>Runtime</h2><p>Context and tools</p></div></div>
      <label>Output<select value={outputKind} disabled={running || executionMode === "agent"} onChange={(event) => setOutputKind(event.target.value as ApiOutputKind)}><option value="text">Text / JSON</option><option value="image">Image</option></select></label>
      {outputKind === "image" && <div className="folder vault-folder"><span>{outputDirectory || "No image result folder selected"}</span><button disabled={running} onClick={() => void chooseOutputDirectory()}>Choose</button></div>}
      <label>Execution mode<select value={executionMode} disabled={running} onChange={(event) => { const value = event.target.value as "prompt" | "agent"; setExecutionMode(value); if (value === "agent") setOutputKind("text") }}><option value="prompt">Prompt</option><option value="agent">Agent</option></select></label>
      <label>Conversation<select value={conversationMode} disabled={running} onChange={(event) => setConversationMode(event.target.value as ConversationMode)}><option value="independent">Independent</option><option value="continue">Continue thread</option><option value="chain">Chain bulk prompts</option></select></label>
      {conversationMode === "continue" && <label>Thread ID <span className="optional">Blank starts new</span><input value={threadId} disabled={running} onChange={(event) => setThreadId(event.target.value)} placeholder="Local conversation ID" /></label>}
      {executionMode === "agent" && <p className="field-help">Agent tools manage files in the installation's <code>.agents</code> workspace.</p>}
    </aside>

    <section className="vault-workspace">
      <div className="workspace-head"><div><p className="eyebrow">API Vault</p><h2>Prompt workspace</h2><p className="workspace-subtitle">Use <code>---</code> to run multiple prompts.</p></div></div>
      <article className="vault-card">
        <div className="vault-field-head"><div><strong>System instruction</strong><span>Optional and separate from assets</span></div><button className="text-button" disabled={running} onClick={() => void loadText("system")}>Load TXT / MD</button></div>
        <textarea className="system-input" value={systemInstruction} disabled={running} onChange={(event) => setSystemInstruction(event.target.value)} placeholder="Define behavior, constraints, or output rules…" />
        <div className="vault-field-head"><div><strong>User prompt</strong><span>{prompts.length} prompt{prompts.length === 1 ? "" : "s"}</span></div><button className="text-button" disabled={running} onClick={() => void loadText("prompt")}>Load TXT / MD</button></div>
        <textarea className="vault-prompt" value={prompt} disabled={running} onChange={(event) => setPrompt(event.target.value)} placeholder={"Enter a prompt…\n\n---\n\nAdd another prompt."} />
        <div className="vault-field-head"><div><strong>Assets</strong><span>Images stay native; documents are parsed locally</span></div><button className="text-button" disabled={running} onClick={() => void addAssets()}>＋ Select assets</button></div>
        <div className="asset-list">{assets.map((asset) => <div className="asset-chip" key={asset.id}><span className="asset-name" title={asset.path}>{asset.name}</span><span className="asset-scope">{asset.kind === "image" ? "Native image" : "Parsed document"}</span><button disabled={running} onClick={() => setAssets((current) => current.filter((item) => item.id !== asset.id))}>×</button></div>)}</div>
      </article>
      {responses.map((response, index) => <article className="vault-response" key={response.runId}><div className="vault-response-head"><strong>Result {index + 1}</strong><span>{response.model}{response.responseId ? ` · ${response.responseId}` : ""}</span></div><pre>{response.text}</pre>{response.files.length > 0 && <div className="vault-files">{response.files.map((file) => <span key={file}>Saved · {file}</span>)}</div>}{response.trace.length > 0 && <details><summary>Agent trace · {response.trace.length} events</summary>{response.trace.map((entry, traceIndex) => <p key={`${entry.label}-${traceIndex}`}><b>{entry.type}</b> · {entry.label} {entry.detail}</p>)}</details>}</article>)}
    </section>

    <aside className="vault-run">
      <div><p className="eyebrow">Execution</p><h2>{executionMode === "agent" ? "Agent ready" : "Prompt ready"}</h2><p>{prompts.length} prompt{prompts.length === 1 ? "" : "s"} · {assets.length} asset{assets.length === 1 ? "" : "s"}</p></div>
      <div className="summary-grid"><div><span>Provider</span><strong>{provider}</strong></div><div><span>Reasoning</span><strong>{reasoning}</strong></div><div><span>Mode</span><strong>{executionMode}</strong></div><div><span>Context</span><strong>{conversationMode}</strong></div></div>
      <div className="message" role="status">{status}</div>
      <button className="run-button" disabled={running || !endpoint.trim() || !model.trim() || !prompts.length || (outputKind === "image" && !outputDirectory)} onClick={() => void run()}><span>{running ? "Running…" : executionMode === "agent" ? "Run agent" : "Run prompt"}</span><b>→</b></button>
    </aside>
  </main>
}
