import { useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ApiModelCatalogItem, ApiOutputKind, ApiProvider, ApiVaultAsset, ApiVaultConversation, ApiVaultModelCatalogs, ApiVaultProgressEvent, ApiVaultProviderSettings, ApiVaultResponse, ApiVaultSettings, ApiVaultTelegramStatus, ConversationMode, ReasoningLevel } from "../shared/api-vault"
import { REASONING_LEVELS } from "../shared/api-vault"
import { parsePromptText } from "../shared/prompt-file"

const PROVIDERS: Array<{ value: ApiProvider; label: string; endpoint: string; model: string }> = [
  { value: "gemini", label: "Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
  { value: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", model: "gpt-5" },
  { value: "9router", label: "9Router", endpoint: "http://localhost:20128/v1", model: "ag/gemini-3.6-flash-low" },
  { value: "custom", label: "Custom", endpoint: "http://localhost:8080/v1", model: "" },
]
type ResultFormat = "auto" | "txt" | "json"
type ResultView = "rendered" | "raw"

function preferredResultView(text: string): ResultView {
  try { JSON.parse(text); return "raw" } catch { /* not JSON */ }
  return /(^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.+\|)|\*\*[^*]+\*\*/m.test(text) ? "rendered" : "raw"
}

function supportedImageRatios(provider: ApiProvider, model: string, parameters: string[] = []): Array<"auto" | "1:1" | "9:16" | "16:9" | "2:3" | "3:2"> {
  const all = ["auto", "1:1", "9:16", "16:9", "2:3", "3:2"] as const
  if (provider === "gemini") return [...all]
  if (provider === "9router" && /antigravity/i.test(model)) return [...all]
  if (provider === "openai" && /^gpt-image/i.test(model)) return ["auto", "1:1", "2:3", "3:2"]
  if (parameters.includes("aspect_ratio") || parameters.includes("aspectRatio")) return [...all]
  if (parameters.includes("size")) return ["auto", "1:1", "2:3", "3:2"]
  return ["auto"]
}

function defaultProfiles(): Record<ApiProvider, ApiVaultProviderSettings> {
  return Object.fromEntries(PROVIDERS.map((item) => [item.value, {
    endpoint: item.endpoint, apiKey: "", model: item.model, imageModel: "", imageAspectRatio: "auto", fallbackModel: "", reasoning: "default",
  }])) as Record<ApiProvider, ApiVaultProviderSettings>
}

function defaultCatalogs(): ApiVaultModelCatalogs {
  return {
    gemini: { chat: [], image: [] },
    openai: { chat: [], image: [] },
    "9router": { chat: [], image: [] },
    custom: { chat: [], image: [] },
  }
}

function defaultModelOptions(): Record<ApiProvider, string[]> {
  return {
    gemini: ["gemini-2.5-flash"],
    openai: ["gpt-5"],
    "9router": ["ag/gemini-3.6-flash-low"],
    custom: [],
  }
}

function emptyModelOptions(): Record<ApiProvider, string[]> {
  return { gemini: [], openai: [], "9router": [], custom: [] }
}

export function ApiVaultView() {
  const [provider, setProvider] = useState<ApiProvider>("9router")
  const [profiles, setProfiles] = useState(defaultProfiles)
  const profile = profiles[provider]
  const { endpoint, apiKey, model, imageModel = "", imageAspectRatio = "auto", fallbackModel, reasoning } = profile
  const [modelCatalogs, setModelCatalogs] = useState<ApiVaultModelCatalogs>(defaultCatalogs)
  const [modelOptions, setModelOptions] = useState<Record<ApiProvider, string[]>>(defaultModelOptions)
  const [imageModelOptions, setImageModelOptions] = useState<Record<ApiProvider, string[]>>(emptyModelOptions)
  const [customModel, setCustomModel] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [executionMode, setExecutionMode] = useState<"independent" | "agent">("independent")
  const [outputKind, setOutputKind] = useState<ApiOutputKind>("text")
  const selectedModel = outputKind === "image" ? imageModel : model
  const selectedImageMetadata = modelCatalogs[provider].image.find((item) => item.id === imageModel)
  const imageRatioOptions = supportedImageRatios(provider, imageModel, selectedImageMetadata?.supportedParameters || [])
  const [outputDirectory, setOutputDirectory] = useState("")
  const [autoSaveResult, setAutoSaveResult] = useState(false)
  const [resultDirectory, setResultDirectory] = useState("")
  const [resultFilename, setResultFilename] = useState("")
  const [resultFormat, setResultFormat] = useState<ResultFormat>("auto")
  const [conversationMode, setConversationMode] = useState<ConversationMode>("independent")
  const [threadId, setThreadId] = useState("")
  const [conversations, setConversations] = useState<ApiVaultConversation[]>([])
  const [systemInstruction, setSystemInstruction] = useState("")
  const [prompt, setPrompt] = useState("")
  const [assets, setAssets] = useState<ApiVaultAsset[]>([])
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState("Configure a provider and enter a prompt.")
  const [response, setResponse] = useState<ApiVaultResponse | null>(null)
  const [resultView, setResultView] = useState<ResultView>("raw")
  const [runError, setRunError] = useState("")
  const [progressEvents, setProgressEvents] = useState<ApiVaultProgressEvent[]>([])
  const [streamedText, setStreamedText] = useState("")
  const [telegramSettings, setTelegramSettings] = useState<NonNullable<ApiVaultSettings["telegram"]>>({ botToken: "", enabled: false, approvedChats: [] })
  const [telegramTokenInput, setTelegramTokenInput] = useState("")
  const [telegramStatus, setTelegramStatus] = useState<ApiVaultTelegramStatus>({ running: false, candidates: [], approvedChats: [] })
  const [telegramBusy, setTelegramBusy] = useState(false)
  const activeRunIds = useRef(new Set<string>())
  const activeRunId = useRef<string | null>(null)
  const prompts = useMemo(() => parsePromptText(prompt), [prompt])

  const updateProfile = (patch: Partial<ApiVaultProviderSettings>) => {
    setProfiles((current) => ({ ...current, [provider]: { ...current[provider], ...patch } }))
  }

  const refreshConversations = async () => {
    const result = await window.autoPrompt.listApiVaultConversations()
    if (result.ok) setConversations(result.value)
    else setStatus(result.error)
  }

  useEffect(() => {
    void (async () => {
      const [settings] = await Promise.all([window.autoPrompt.loadApiVaultSettings(), refreshConversations()])
      if (settings.ok && settings.value?.version === 1) {
        setProvider(settings.value.activeProvider)
        const restoredProfiles = { ...defaultProfiles(), ...settings.value.providers }
        for (const item of PROVIDERS) {
          restoredProfiles[item.value] = { ...defaultProfiles()[item.value], ...settings.value.providers[item.value] }
        }
        setProfiles(restoredProfiles)
        if (settings.value.modelCatalogs) {
          setModelCatalogs(settings.value.modelCatalogs)
          setModelOptions((current) => Object.fromEntries(PROVIDERS.map((item) => [item.value, settings.value!.modelCatalogs?.[item.value]?.chat.map((model) => model.id) || current[item.value]])) as Record<ApiProvider, string[]>)
          setImageModelOptions((current) => Object.fromEntries(PROVIDERS.map((item) => [item.value, settings.value!.modelCatalogs?.[item.value]?.image.map((model) => model.id) || current[item.value]])) as Record<ApiProvider, string[]>)
        }
        if (settings.value.executionMode) setExecutionMode(settings.value.executionMode === "prompt" ? "independent" : settings.value.executionMode)
        if (settings.value.telegram) {
          setTelegramSettings(settings.value.telegram)
          setTelegramTokenInput(settings.value.telegram.botToken || "")
          if (settings.value.telegram.enabled && settings.value.telegram.botToken) {
            const remote = await window.autoPrompt.startApiVaultTelegram(settings.value)
            if (remote.ok) setTelegramStatus(remote.value)
            else setTelegramStatus((current) => ({ ...current, running: false, lastError: remote.error }))
          }
        }
        if (settings.value.conversationMode) setConversationMode(settings.value.conversationMode)
        const savedModel = settings.value.providers[settings.value.activeProvider]?.model
        if (savedModel && !settings.value.modelCatalogs?.[settings.value.activeProvider]?.chat.length) setModelOptions((current) => ({ ...current, [settings.value!.activeProvider]: [savedModel] }))
      } else if (!settings.ok) setStatus(settings.error)
      setSettingsLoaded(true)
    })()
  }, [])

  useEffect(() => {
    if (outputKind === "image" && !imageRatioOptions.includes(imageAspectRatio)) {
      setProfiles((current) => ({ ...current, [provider]: { ...current[provider], imageAspectRatio: "auto" } }))
    }
  }, [outputKind, provider, imageModel, imageAspectRatio, imageRatioOptions.join(",")])

  useEffect(() => {
    const currentSelection = outputKind === "image" ? imageModel : model
    const options = outputKind === "image" ? imageModelOptions[provider] : modelOptions[provider]
    setCustomModel(!currentSelection || !options.includes(currentSelection))
  }, [outputKind, provider, imageModel, model, imageModelOptions, modelOptions])

  useEffect(() => window.autoPrompt.onApiVaultProgress((event) => {
    if (!activeRunIds.current.has(event.runId)) return
    if (typeof event.textDelta === "string") {
      setStreamedText((current) => current + event.textDelta)
      return
    }
    setProgressEvents((current) => [...current, event].slice(-200))
  }), [])

  useEffect(() => {
    if (!settingsLoaded) return
    const timer = window.setTimeout(() => {
      const settings: ApiVaultSettings = { version: 1, activeProvider: provider, providers: profiles, executionMode, conversationMode, modelCatalogs, telegram: telegramSettings }
      void window.autoPrompt.saveApiVaultSettings(settings).then(async (result) => {
        if (!result.ok) setStatus(`Settings were not saved: ${result.error}`)
        else if (telegramSettings.enabled) {
          const remote = await window.autoPrompt.updateApiVaultTelegramSettings(settings)
          if (remote.ok) setTelegramStatus(remote.value)
        }
      })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [provider, profiles, executionMode, conversationMode, modelCatalogs, telegramSettings, settingsLoaded])

  useEffect(() => {
    let stopped = false
    const refresh = async () => {
      const result = await window.autoPrompt.getApiVaultTelegramStatus()
      if (!stopped && result.ok) setTelegramStatus(result.value)
    }
    void refresh()
    if (telegramSettings.enabled || telegramStatus.running) {
      const timer = window.setInterval(() => { void refresh() }, 2_000)
      return () => { stopped = true; window.clearInterval(timer) }
    }
    return () => { stopped = true }
  }, [telegramSettings.enabled, telegramStatus.running])

  const connectTelegram = async () => {
    const token = telegramTokenInput.trim()
    if (!token) { setTelegramStatus((current) => ({ ...current, lastError: "Enter the Telegram BotFather token first." })); return }
    setTelegramBusy(true)
    try {
      const validation = await window.autoPrompt.validateApiVaultTelegramBot(token)
      if (!validation.ok) { setTelegramStatus((current) => ({ ...current, lastError: validation.error })); return }
      const nextTelegram = {
        ...telegramSettings,
        botToken: token,
        enabled: true,
        botId: validation.value.id,
        botName: validation.value.firstName,
        botUsername: validation.value.username,
      }
      const nextSettings: ApiVaultSettings = { version: 1, activeProvider: provider, providers: profiles, executionMode, conversationMode, modelCatalogs, telegram: nextTelegram }
      setTelegramSettings(nextTelegram)
      const connected = await window.autoPrompt.startApiVaultTelegram(nextSettings)
      if (!connected.ok) {
        setTelegramSettings((current) => ({ ...current, enabled: false }))
        setTelegramStatus((current) => ({ ...current, running: false, lastError: connected.error }))
        return
      }
      setTelegramStatus(connected.value)
      setStatus("Telegram bot connected. Open a pairing window and approve users from this desktop.")
      const saved = await window.autoPrompt.saveApiVaultSettings(nextSettings)
      if (!saved.ok) setTelegramStatus((current) => ({ ...current, lastError: "Connected for this session, but secure settings were not saved: " + saved.error }))
    } finally { setTelegramBusy(false) }
  }

  const openTelegramPairing = async () => {
    setTelegramBusy(true)
    try {
      if (!telegramStatus.running) {
        const settings: ApiVaultSettings = { version: 1, activeProvider: provider, providers: profiles, executionMode, conversationMode, modelCatalogs, telegram: { ...telegramSettings, botToken: telegramTokenInput.trim() || telegramSettings.botToken, enabled: true } }
        const connected = await window.autoPrompt.startApiVaultTelegram(settings)
        if (!connected.ok) { setTelegramStatus((current) => ({ ...current, lastError: connected.error })); return }
        setTelegramStatus(connected.value)
      }
      const pairing = await window.autoPrompt.beginApiVaultTelegramPairing()
      if (pairing.ok) setTelegramStatus(pairing.value)
      else setTelegramStatus((current) => ({ ...current, lastError: pairing.error }))
    } finally { setTelegramBusy(false) }
  }

  const approveTelegramPair = async (userId: number, chatId: number) => {
    setTelegramBusy(true)
    try {
      const approval = await window.autoPrompt.approveApiVaultTelegramCandidate(userId, chatId)
      if (!approval.ok) { setTelegramStatus((current) => ({ ...current, lastError: approval.error })); return }
      setTelegramStatus(approval.value)
      setTelegramSettings((current) => ({ ...current, approvedChats: approval.value.approvedChats }))
    } finally { setTelegramBusy(false) }
  }

  const revokeTelegramPair = async (userId: number, chatId: number) => {
    const approvedChats = telegramSettings.approvedChats.filter((item) => !(item.userId === userId && item.chatId === chatId))
    const nextTelegram = { ...telegramSettings, approvedChats }
    const nextSettings: ApiVaultSettings = { version: 1, activeProvider: provider, providers: profiles, executionMode, conversationMode, modelCatalogs, telegram: nextTelegram }
    const result = await window.autoPrompt.updateApiVaultTelegramSettings(nextSettings)
    if (!result.ok) { setTelegramStatus((current) => ({ ...current, lastError: result.error })); return }
    setTelegramStatus(result.value)
    setTelegramSettings(nextTelegram)
  }

  const disconnectTelegram = async () => {
    setTelegramBusy(true)
    try {
      await window.autoPrompt.disconnectApiVaultTelegram()
      const empty = { botToken: "", enabled: false, approvedChats: [] }
      setTelegramSettings(empty)
      setTelegramTokenInput("")
      setTelegramStatus({ running: false, candidates: [], approvedChats: [] })
      setStatus("Telegram disconnected. The saved Bot API token and local allowlist were cleared.")
      await window.autoPrompt.saveApiVaultSettings({ version: 1, activeProvider: provider, providers: profiles, executionMode, conversationMode, modelCatalogs, telegram: empty })
    } finally { setTelegramBusy(false) }
  }

  const changeProvider = (value: ApiProvider) => {
    setProvider(value)
    const nextModel = outputKind === "image" ? (profiles[value].imageModel || "") : profiles[value].model
    const options = outputKind === "image" ? imageModelOptions[value] : modelOptions[value]
    setCustomModel(!nextModel || !options.includes(nextModel))
  }

  const refreshModels = async () => {
    setStatus(`Loading ${outputKind === "image" ? "Image" : "Chat"} models…`)
    const result = await window.autoPrompt.listApiVaultModelCatalog(provider, endpoint, apiKey, outputKind)
    if (!result.ok) {
      const detail = result.error
      const networkFailure = /fetch failed|failed to fetch|networkerror|could not connect|connection refused|econnrefused|timed out/i.test(detail)
      if (networkFailure && provider === "9router") {
        return setStatus(`Cannot reach 9Router. Make sure 9Router is running and the Base URL/port are correct. Details: ${detail}`)
      }
      if (networkFailure) {
        return setStatus(`Cannot reach the ${provider} API. Check the Base URL and network connection. Details: ${detail}`)
      }
      return setStatus(`Could not fetch the model catalog from ${provider}. Check the Base URL and API key. Details: ${detail}`)
    }
    if (!result.value.length) return setStatus(`No valid ${outputKind === "image" ? "Image" : "Chat"} models were returned; the previous catalog is preserved.`)
    const ids = result.value.map((item) => item.id)
    setModelCatalogs((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        ...(outputKind === "image" ? { image: result.value, imageRefreshedAt: new Date().toISOString() } : { chat: result.value, chatRefreshedAt: new Date().toISOString() }),
      },
    }))
    if (outputKind === "image") setImageModelOptions((current) => ({ ...current, [provider]: ids }))
    else setModelOptions((current) => ({ ...current, [provider]: ids }))
    // Keep the user's current model selection. Refreshing discovery must not silently substitute another model.
    const currentSelection = outputKind === "image" ? imageModel : model
    setCustomModel(!currentSelection || !ids.includes(currentSelection))
    setStatus(`Loaded ${ids.length} ${outputKind === "image" ? "Image" : "Chat"} model${ids.length === 1 ? "" : "s"}.`)
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

  const chooseResultDirectory = async (): Promise<string> => {
    const result = await window.autoPrompt.pickDownloadDirectory()
    if (!result.ok) { setStatus(result.error); return "" }
    if (!result.value) return ""
    setResultDirectory(result.value)
    return result.value
  }

  const resolvedResultFormat = (text: string): "txt" | "json" => {
    if (resultFormat !== "auto") return resultFormat
    try { JSON.parse(text); return "json" } catch { return "txt" }
  }

  const saveResponse = async (value: ApiVaultResponse, directory = resultDirectory): Promise<ApiVaultResponse | null> => {
    const destination = directory || await chooseResultDirectory()
    if (!destination) return null
    const result = await window.autoPrompt.saveApiVaultResult(destination, resultFilename, value.text, resolvedResultFormat(value.text))
    if (!result.ok) { setStatus(result.error); return null }
    setStatus(`Saved · ${result.value}`)
    return { ...value, files: value.files.includes(result.value) ? value.files : [...value.files, result.value] }
  }

  const saveExistingResponse = async (value: ApiVaultResponse) => {
    const saved = await saveResponse(value)
    if (saved) setResponse(saved)
  }

  const newConversation = () => {
    setThreadId("")
    setResponse(null)
    setRunError("")
    setStatus("New conversation. The next run starts a fresh context.")
  }

  const deleteConversation = async () => {
    if (!threadId || !window.confirm("Delete this saved conversation?")) return
    const result = await window.autoPrompt.deleteApiVaultConversation(threadId)
    if (!result.ok) return setStatus(result.error)
    newConversation()
    await refreshConversations()
    setStatus("Conversation deleted.")
  }

  const stopCurrentRun = async () => {
    const runId = activeRunId.current
    if (!runId) return
    setStatus("Requesting cancellation…")
    const result = await window.autoPrompt.cancelApiVaultRun(runId)
    setStatus(result.ok ? "Stop requested." : result.error)
  }

  const run = async () => {
    if (!endpoint.trim() || !selectedModel.trim() || !prompts.length) return
    if (outputKind === "image" && assets.length) {
      const message = "Direct Image does not use Chat attachments. Remove selected assets before generating an image."
      setRunError(message); setStatus(message); return
    }
    setRunning(true); setRunError(""); setResponse(null); setProgressEvents([]); setStreamedText(""); activeRunIds.current.clear()
    let activeThreadId: string | undefined = conversationMode === "independent" ? undefined : threadId || undefined
    let completedCount = 0
    try {
      for (let index = 0; index < prompts.length; index += 1) {
        const runId = crypto.randomUUID()
        activeRunIds.current.add(runId)
        activeRunId.current = runId
        setStreamedText("")
        setStatus(`Running prompt ${index + 1} of ${prompts.length}…`)
        const result = await window.autoPrompt.runApiVault({
          runId,
          provider, endpoint, apiKey, model: selectedModel, imageModel: imageModel || undefined, imageModelCatalog: modelCatalogs[provider].image, imageAspectRatio, fallbackModel: provider === "9router" ? fallbackModel : undefined,
          reasoning, outputKind, outputDirectory: outputKind === "image" ? outputDirectory : undefined,
          executionMode, conversationMode: conversationMode === "independent" ? "independent" : "continue",
          threadId: activeThreadId, systemInstruction: outputKind === "image" ? "" : systemInstruction, prompt: prompts[index], assets: outputKind === "image" ? [] : assets,
        })
        if (!result.ok) throw new Error(result.error)
        activeThreadId = result.value.threadId
        if (activeThreadId) setThreadId(activeThreadId)
        let completed = result.value
        if (outputKind === "text" && autoSaveResult && resultDirectory) completed = await saveResponse(result.value, resultDirectory) || result.value
        setResponse(completed)
        setResultView(preferredResultView(completed.text))
        completedCount += 1
      }
      await refreshConversations()
      setStatus(`Completed ${completedCount} prompt${completedCount === 1 ? "" : "s"}.${outputKind === "text" && autoSaveResult && !resultDirectory ? " Result not saved because no folder was selected." : ""}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setResponse(null)
      setRunError(message)
      setStatus(message)
    } finally { activeRunId.current = null; setRunning(false) }
  }

  return <main className="vault-layout">
    <aside className="vault-config">
      <div className="section-heading"><span>01</span><div><h2>Provider</h2><p>Direct API connection</p></div></div>
      <label>Provider<select value={provider} disabled={running} onChange={(event) => changeProvider(event.target.value as ApiProvider)}>{PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label>Base URL<input value={endpoint} disabled={running} onChange={(event) => updateProfile({ endpoint: event.target.value })} /></label>
      <label>API key<input type="password" autoComplete="off" value={apiKey} disabled={running} onChange={(event) => updateProfile({ apiKey: event.target.value })} placeholder={provider === "9router" ? "Optional when local auth is disabled" : "Required by provider"} /></label>
      <label>{outputKind === "image" ? "Image model" : "Chat model"}<div className="model-picker"><select value={customModel ? "__custom__" : selectedModel} disabled={running} onChange={(event) => { if (event.target.value === "__custom__") setCustomModel(true); else { setCustomModel(false); updateProfile(outputKind === "image" ? { imageModel: event.target.value } : { model: event.target.value }) } }}>{(outputKind === "image" ? modelCatalogs[provider].image : modelCatalogs[provider].chat).map((item: ApiModelCatalogItem) => <option value={item.id} key={item.id}>{item.owned_by ? `${item.owned_by} · ${item.id}` : item.id}</option>)}{(outputKind === "image" ? imageModelOptions[provider] : modelOptions[provider]).filter((value) => !(outputKind === "image" ? modelCatalogs[provider].image : modelCatalogs[provider].chat).some((item) => item.id === value)).map((value) => <option value={value} key={value}>{value}</option>)}<option value="__custom__">Custom model ID…</option></select><button className="secondary" type="button" disabled={running || !endpoint.trim()} onClick={() => void refreshModels()}>Refresh</button></div></label>
      {customModel && <label>Custom model ID<input value={selectedModel} disabled={running} onChange={(event) => updateProfile(outputKind === "image" ? { imageModel: event.target.value } : { model: event.target.value })} placeholder={outputKind === "image" ? "Image model ID" : "Chat model ID"} /></label>}
      {provider === "9router" && <label>Fallback model <span className="optional">Optional</span><input list="api-vault-model-options" value={fallbackModel} disabled={running} onChange={(event) => updateProfile({ fallbackModel: event.target.value })} placeholder="Used only after a provider error" /></label>}
      <datalist id="api-vault-model-options">{modelOptions[provider].map((value) => <option value={value} key={value} />)}</datalist>
      {outputKind === "text" && <label>Reasoning<select value={reasoning} disabled={running} onChange={(event) => updateProfile({ reasoning: event.target.value as ReasoningLevel })}>{REASONING_LEVELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>}
      <p className="field-help">Provider settings are saved per provider. API keys are protected by Windows.</p>
      <div className="section-heading vault-section"><span>02</span><div><h2>Runtime</h2><p>Context and tools</p></div></div>
      <label>Output<select value={outputKind} disabled={running} onChange={(event) => { const value = event.target.value as ApiOutputKind; setOutputKind(value); if (value === "image") { setExecutionMode("independent"); setConversationMode("independent"); setThreadId("") } }}><option value="text">Chat</option><option value="image">Image</option></select></label>
      {outputKind === "image" && <div className="folder vault-folder"><span>{outputDirectory || "No image result folder selected"}</span><button disabled={running} onClick={() => void chooseOutputDirectory()}>Choose</button></div>}
      {outputKind === "image" && imageRatioOptions.length > 1 && <label>Aspect ratio<select value={imageAspectRatio} disabled={running} onChange={(event) => updateProfile({ imageAspectRatio: event.target.value as ApiVaultProviderSettings["imageAspectRatio"] })}>{imageRatioOptions.map((ratio) => <option key={ratio} value={ratio}>{ratio === "auto" ? "Auto" : ratio}</option>)}</select></label>}
      {outputKind === "text" && <div className="result-save-settings">
        <label className="toggle-row"><span><strong>Auto-save result</strong><small>Run still works when no folder is selected</small></span><input type="checkbox" checked={autoSaveResult} disabled={running} onChange={(event) => setAutoSaveResult(event.target.checked)} /></label>
        <label>File format<select value={resultFormat} disabled={running} onChange={(event) => setResultFormat(event.target.value as ResultFormat)}><option value="auto">Auto-detect</option><option value="txt">TXT</option><option value="json">JSON</option></select></label>
        <label>Filename <span className="optional">Optional</span><input value={resultFilename} disabled={running} onChange={(event) => setResultFilename(event.target.value)} placeholder="Automatic when blank" /></label>
        <div className="folder vault-folder"><span>{resultDirectory || "No text result folder selected"}</span><button disabled={running} onClick={() => void chooseResultDirectory()}>Choose</button></div>
      </div>}
      {outputKind === "text" && <><label>Execution mode<select value={executionMode} disabled={running} onChange={(event) => { const value = event.target.value as "independent" | "agent"; setExecutionMode(value); if (value === "agent") { setOutputKind("text"); setConversationMode("continue") } }}><option value="independent">Independent</option><option value="agent">Agent</option></select></label>
      <label>Context<select value={conversationMode} disabled={running} onChange={(event) => { setConversationMode(event.target.value as ConversationMode); setThreadId("") }}><option value="independent">Independent</option><option value="continue">Conversation</option><option value="chain">Chain bulk prompts</option></select></label>
      {conversationMode !== "independent" && <div className="conversation-manager">
        <label>Conversation <span className="optional">Blank starts new</span><select value={threadId} disabled={running} onChange={(event) => { setThreadId(event.target.value); setResponse(null); setRunError("") }}><option value="">New conversation</option>{conversations.map((item) => <option value={item.id} key={item.id}>{item.title} · {item.turnCount} turn{item.turnCount === 1 ? "" : "s"}</option>)}</select></label>
        <div className="conversation-actions"><button className="secondary" disabled={running || !threadId} onClick={newConversation}>New</button><button className="danger-button" disabled={running || !threadId} onClick={() => void deleteConversation()}>Delete</button></div>
      </div>}
      <p className="field-help">{executionMode === "agent"
        ? <>Agent uses tools and saves each completed turn to the selected conversation.</>
        : <>Independent uses the full primary agent in an unsaved branch. A selected conversation is loaded as context without changing its saved history.</>}</p></>}
      {outputKind === "image" && <p className="field-help">Direct Image runs each prompt independently and does not use conversation history, system instructions, reasoning, or Chat assets.</p> }
      <div className="section-heading vault-section"><span>03</span><div><h2>Telegram remote client</h2><p>Local runtime · private chats only</p></div></div>
      <div className="telegram-settings">
        <label>BotFather token<input type="password" autoComplete="off" value={telegramTokenInput} onChange={(event) => setTelegramTokenInput(event.target.value)} placeholder={telegramSettings.botUsername ? "Saved token for @" + telegramSettings.botUsername : "Paste bot token to validate and connect"} /></label>
        <p className="field-help">The token is stored using Windows OS-backed protection. Pairing must be approved on this desktop; a Telegram message cannot authorize itself.</p>
        <div className="conversation-actions">
          <button className="secondary" disabled={telegramBusy || !telegramTokenInput.trim()} onClick={() => void connectTelegram()}>{telegramBusy ? "Working…" : "Validate & connect"}</button>
          <button className="secondary" disabled={telegramBusy || !telegramStatus.running} onClick={() => void openTelegramPairing()}>Open 5-minute pairing</button>
          <button className="danger-button" disabled={telegramBusy || (!telegramSettings.botToken && !telegramStatus.running)} onClick={() => void disconnectTelegram()}>Disconnect</button>
        </div>
        <p className="field-help" role="status">{telegramStatus.running ? "Connected" + (telegramStatus.bot?.username ? " · @" + telegramStatus.bot.username : telegramSettings.botUsername ? " · @" + telegramSettings.botUsername : "") : "Not connected"}{telegramStatus.pairingUntil ? " · Pairing closes " + new Date(telegramStatus.pairingUntil).toLocaleTimeString() : ""}</p>
        {telegramStatus.lastError && <p className="field-help" role="alert">{telegramStatus.lastError}</p>}
        {telegramStatus.candidates.length > 0 && <div className="conversation-manager">
          <strong>Pending pairing approvals</strong>
          {telegramStatus.candidates.map((candidate) => <div className="asset-chip" key={candidate.userId + ":" + candidate.chatId}>
            <span className="asset-name">{[candidate.firstName, candidate.lastName].filter(Boolean).join(" ") || "Telegram user"}{candidate.username ? " · @" + candidate.username : ""}<small>User {candidate.userId} · Private chat {candidate.chatId}</small></span>
            <button className="secondary" disabled={telegramBusy} onClick={() => void approveTelegramPair(candidate.userId, candidate.chatId)}>Approve</button>
          </div>)}
        </div>}
        {telegramSettings.approvedChats.length > 0 && <div className="conversation-manager">
          <strong>Authorized private chats</strong>
          {telegramSettings.approvedChats.map((peer) => <div className="asset-chip" key={peer.userId + ":" + peer.chatId}>
            <span className="asset-name">{[peer.firstName, peer.lastName].filter(Boolean).join(" ") || "Telegram user"}{peer.username ? " · @" + peer.username : ""}<small>User {peer.userId} · Private chat {peer.chatId}</small></span>
            <button className="danger-button" disabled={telegramBusy} onClick={() => void revokeTelegramPair(peer.userId, peer.chatId)}>Revoke</button>
          </div>)}
        </div>}
        <p className="field-help">Commands: <code>/mode agent</code>, <code>/mode prompt</code>, <code>/new</code>, <code>/conversations</code>, <code>/use id</code>, <code>/stop</code>. Attachments enter a controlled local inbox and use the same filesystem authorization rules.</p>
      </div>
    </aside>

    <section className="vault-workspace">
      <div className="workspace-head"><div><p className="eyebrow">API Vault</p><h2>Prompt workspace</h2><p className="workspace-subtitle">Use <code>---</code> to run multiple prompts. Bulk prompts run independently unless chaining is explicitly selected.</p></div></div>
      <article className="vault-card">
        {outputKind === "text" && <><div className="vault-field-head"><div><strong>System instruction</strong><span>Optional and separate from assets</span></div><button className="text-button" disabled={running} onClick={() => void loadText("system")}>Load TXT / MD</button></div>
        <textarea className="system-input" value={systemInstruction} disabled={running} onChange={(event) => setSystemInstruction(event.target.value)} placeholder="Define behavior, constraints, or output rules…" />
        </>}
        <div className="vault-field-head"><div><strong>User prompt</strong><span>{prompts.length} prompt{prompts.length === 1 ? "" : "s"}</span></div><button className="text-button" disabled={running} onClick={() => void loadText("prompt")}>Load TXT / MD</button></div>
        <textarea className="vault-prompt" value={prompt} disabled={running} onChange={(event) => setPrompt(event.target.value)} placeholder={"Enter a prompt…\n\n---\n\nAdd another prompt."} />
        {outputKind === "text" && <><div className="vault-field-head"><div><strong>Assets</strong><span>Images stay native; documents are parsed locally</span></div><button className="text-button" disabled={running} onClick={() => void addAssets()}>＋ Select assets</button></div>
        <div className="asset-list">{assets.map((asset) => <div className="asset-chip" key={asset.id}><span className="asset-name" title={asset.path}>{asset.name}</span><span className="asset-scope">{asset.kind === "image" ? "Native image" : "Parsed document"}</span><button disabled={running} onClick={() => setAssets((current) => current.filter((item) => item.id !== asset.id))}>×</button></div>)}</div></>}
      </article>
      {running && streamedText.length > 0 && <article className="vault-response vault-live" aria-live="polite"><div className="vault-response-head"><div><strong>Live assistant output</strong><span>Real provider text deltas</span></div></div><pre className="raw-result">{streamedText}</pre></article>}
      {progressEvents.length > 0 && <article className="vault-response vault-live" aria-live="polite">
        <div className="vault-response-head"><div><strong>Live activity</strong><span>{running ? "Working" : "Completed"} · real tool results</span></div></div>
        <div className="agent-transcript">{progressEvents.map((event, index) => <div className={`agent-event phase-${event.phase}`} key={`${event.runId}-${index}`}><i /><span>{event.message}</span></div>)}</div>
      </article>}
      {runError && <article className="vault-response vault-response-error" role="alert"><div className="vault-response-head"><div><strong>Run failed</strong><span>Provider / agent error</span></div></div><pre>{runError}</pre></article>}
      {response && <article className="vault-response" key={response.runId}>
        <div className="vault-response-head">
          <div><strong>Latest result</strong><span>{response.model}{response.responseId ? ` · ${response.responseId}` : ""}</span></div>
          <div className="result-actions">
            <div className="result-view-toggle" role="group" aria-label="Result view">
              <button className={resultView === "rendered" ? "active" : ""} onClick={() => setResultView("rendered")}>Rendered</button>
              <button className={resultView === "raw" ? "active" : ""} onClick={() => setResultView("raw")}>Raw</button>
            </div>
            <button className="secondary" onClick={() => void navigator.clipboard.writeText(response.text)}>Copy</button>
            {outputKind === "text" && <button className="secondary" onClick={() => void saveExistingResponse(response)}>Save result</button>}
          </div>
        </div>
        {resultView === "rendered"
          ? <div className="markdown-result"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{response.text}</ReactMarkdown></div>
          : <pre className="raw-result">{response.text}</pre>}
        {response.files.length > 0 && <div className="vault-files">{response.files.map((file) => <span key={file}>Saved · {file}</span>)}</div>}
        {response.trace.length > 0 && <details><summary>Tool trace · {response.trace.length} events</summary>{response.trace.map((entry, traceIndex) => <p key={`${entry.label}-${traceIndex}`}><b>{entry.type}</b> · {entry.label} {entry.detail}</p>)}</details>}
      </article>}
    </section>

    <aside className="vault-run">
      <div><p className="eyebrow">Execution</p><h2>{outputKind === "image" ? "Direct Image ready" : executionMode === "agent" ? "Agent ready" : "Independent ready"}</h2><p>{prompts.length} prompt{prompts.length === 1 ? "" : "s"} · {assets.length} asset{assets.length === 1 ? "" : "s"}</p></div>
      <div className="summary-grid"><div><span>Provider</span><strong>{provider}</strong></div>{outputKind === "text" && <><div><span>Reasoning</span><strong>{reasoning}</strong></div><div><span>Mode</span><strong>{executionMode}</strong></div><div><span>Context</span><strong>{conversationMode}</strong></div></>}</div>
      <div className="message" role="status">{status}</div>
      {running && <button className="danger-button" type="button" onClick={() => void stopCurrentRun()}>Stop current run</button>}
      <button className="run-button" disabled={running || !settingsLoaded || !endpoint.trim() || !selectedModel.trim() || !prompts.length || (outputKind === "image" && !outputDirectory)} onClick={() => void run()}><span>{running ? "Running…" : outputKind === "image" ? "Generate image" : executionMode === "agent" ? "Run agent" : "Run independent"}</span><b>→</b></button>
    </aside>
  </main>
}
