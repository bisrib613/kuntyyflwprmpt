import { useEffect, useMemo, useState } from "react"
import "./bridge"
import type { AssetInput, DownloadQuality, FlowpilotAccount, OutputKind, PromptJob, QueueEvent, RunSettings, UpdateState } from "../shared/contracts"
import { NEXT_UPDATE_PATCHES, PATCH_LOG } from "../shared/patch-log"
import { parsePromptFile, parsePromptText } from "../shared/prompt-file"

const IMAGE_MODELS = ["Nano Banana 2 Lite", "Nano Banana 2", "Nano Banana Pro"]
const VIDEO_MODELS = ["Omni 1.1 Flash", "Veo 3.1 Lite", "Veo 3.1 Fast", "Veo 3.1 Quality"]
const IMAGE_QUALITIES: Array<[DownloadQuality, string]> = [["original-1k", "Original 1K"], ["upscale-2k", "2K Upscaled"], ["upscale-4k", "4K · fallback 2K"]]
const VIDEO_QUALITIES: Array<[DownloadQuality, string]> = [["original-720p", "Original 720p"], ["upscale-1080p", "1080p · fallback 720p"], ["upscale-4k", "4K · fallback 1080p / 720p"], ["gif-270p", "Animated GIF 270p"]]
type AppView = "flow" | "docs" | "settings"

function createJob(prompt = ""): PromptJob {
  return { id: crypto.randomUUID(), prompt, assets: [], status: "draft", progress: 0, downloads: [] }
}

function AssetList({ assets, inherited = false, canShare, disabled, onRemove, onShare }: {
  assets: AssetInput[]
  inherited?: boolean
  canShare: boolean
  disabled: boolean
  onRemove?: (id: string) => void
  onShare?: (id: string, shared: boolean) => void
}) {
  if (!assets.length) return null
  return <div className={`asset-list ${inherited ? "inherited-assets" : ""}`}>{assets.map((asset) => <div className="asset-chip" key={asset.id}>
    <span className="asset-name" title={asset.name}>{asset.name}</span>
    {inherited ? <span className="asset-scope">All jobs</span> : canShare ? <label className="asset-share"><input type="checkbox" checked={Boolean(asset.shared)} disabled={disabled} onChange={(event) => onShare?.(asset.id, event.target.checked)} /><span>All jobs</span></label> : null}
    {!inherited && <button aria-label={`Remove ${asset.name}`} disabled={disabled} onClick={() => onRemove?.(asset.id)}>×</button>}
  </div>)}</div>
}

export function App() {
  const [view, setView] = useState<AppView>("flow")
  const [accounts, setAccounts] = useState<FlowpilotAccount[]>([])
  const [accountId, setAccountId] = useState("")
  const [projectMode, setProjectMode] = useState<RunSettings["projectMode"]>("recent")
  const [newProjectName, setNewProjectName] = useState("")
  const [output, setOutput] = useState<OutputKind>("image")
  const [model, setModel] = useState(IMAGE_MODELS[0])
  const [ratio, setRatio] = useState<RunSettings["aspectRatio"]>("16:9")
  const [variants, setVariants] = useState<1 | 2 | 3>(1)
  const [quality, setQuality] = useState<DownloadQuality>("original-1k")
  const [autoDownload, setAutoDownload] = useState(true)
  const [downloadDirectory, setDownloadDirectory] = useState("")
  const [jobs, setJobs] = useState<PromptJob[]>([createJob()])
  const [message, setMessage] = useState("Choose a FlowPilot account and prepare your prompts.")
  const [running, setRunning] = useState(false)
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const [logDirectory, setLogDirectory] = useState("Loading…")
  const [updateState, setUpdateState] = useState<UpdateState>({ currentVersion: "0.1.0", phase: "idle", message: "Updates are checked automatically." })

  useEffect(() => {
    void window.autoPrompt.listAccounts().then((result) => {
      if (!result.ok) return setMessage(result.error)
      setAccounts(result.value)
      if (result.value[0]) setAccountId(result.value[0].id)
      if (!result.value.length) setMessage("No signed-in Google Flow profiles were found in FlowPilot.")
    })
    void window.autoPrompt.getUpdateState().then(setUpdateState)
    void window.autoPrompt.getLogDirectory().then((result) => setLogDirectory(result.ok ? result.value : result.error))
    const updateTimer = window.setTimeout(() => { void window.autoPrompt.checkForUpdates() }, 15_000)
    const stopQueueEvents = window.autoPrompt.onQueueEvent((event: QueueEvent) => {
      setMessage(event.message)
      if (event.jobId) setJobs((current) => current.map((job) => job.id === event.jobId ? { ...job, status: event.status as PromptJob["status"], progress: event.progress ?? job.progress, downloads: event.downloads ?? job.downloads, error: event.status === "failed" ? event.message : undefined } : job))
      if (event.status === "stopped") setRunning(false)
    })
    const stopUpdateEvents = window.autoPrompt.onUpdateState(setUpdateState)
    return () => { window.clearTimeout(updateTimer); stopQueueEvents(); stopUpdateEvents() }
  }, [])

  const qualityOptions = output === "image" ? IMAGE_QUALITIES : VIDEO_QUALITIES
  const models = output === "image" ? IMAGE_MODELS : VIDEO_MODELS
  const ratios = output === "image" ? ["16:9", "4:3", "1:1", "3:4", "9:16"] as const : ["16:9", "9:16"] as const
  const completed = jobs.filter((job) => job.status === "completed").length
  const progress = jobs.length ? Math.round(jobs.reduce((sum, job) => sum + job.progress, 0) / jobs.length) : 0
  const promptCount = jobs.reduce((sum, job) => sum + parsePromptText(job.prompt).length, 0)
  const sharedAssets = useMemo(() => jobs.flatMap((job) => job.assets.filter((asset) => asset.shared)), [jobs])
  const canRun = Boolean(accountId) && promptCount > 0 && jobs.every((job) => parsePromptText(job.prompt).length > 0) && (!autoDownload || Boolean(downloadDirectory)) && !running

  useEffect(() => {
    const nextModels = output === "image" ? IMAGE_MODELS : VIDEO_MODELS
    setModel(nextModels[0])
    setQuality(output === "image" ? "original-1k" : "original-720p")
    if (output === "video" && !["16:9", "9:16"].includes(ratio)) setRatio("16:9")
  }, [output])

  const addAssets = async (jobId: string) => {
    const result = await window.autoPrompt.pickAssets()
    if (!result.ok) return setMessage(result.error)
    setJobs((current) => current.map((job) => job.id === jobId ? { ...job, assets: [...job.assets, ...result.value.map((asset) => ({ ...asset, shared: false }))] } : job))
  }

  const importPrompts = async () => {
    const result = await window.autoPrompt.pickPromptFile()
    if (!result.ok) return setMessage(result.error)
    if (!result.value) return
    const prompts = parsePromptFile(result.value.text)
    if (!prompts.length) return setMessage(`${result.value.name} did not contain any prompts.`)
    const prompt = prompts.join("\n---\n")
    setJobs((current) => current.length === 1 && !current[0].prompt.trim() ? [{ ...current[0], prompt }] : [...current, createJob(prompt)])
    setMessage(`Imported ${prompts.length} prompt(s) as one job from ${result.value.name}.`)
  }

  const chooseDirectory = async () => {
    const result = await window.autoPrompt.pickDownloadDirectory()
    if (!result.ok) return setMessage(result.error)
    if (result.value) setDownloadDirectory(result.value)
  }

  const updateJob = (id: string, patch: Partial<PromptJob>) => setJobs((current) => current.map((job) => job.id === id ? { ...job, ...patch } : job))
  const updateAsset = (jobId: string, assetId: string, shared: boolean) => setJobs((current) => current.map((job) => job.id === jobId ? { ...job, assets: job.assets.map((asset) => asset.id === assetId ? { ...asset, shared } : asset) } : job))

  const start = async () => {
    const settings: RunSettings = {
      accountId, projectMode, newProjectName, output, model, aspectRatio: ratio, variants, quality, autoDownload, downloadDirectory,
      jobs: jobs.map((job) => ({ ...job, status: "queued", progress: 0, downloads: [], error: undefined })),
    }
    setJobs(settings.jobs); setRunning(true); setMessage("Preparing the FlowPilot session and opening Google Flow…")
    const result = await window.autoPrompt.startRun(settings)
    if (!result.ok) { setRunning(false); setMessage(result.error) }
  }

  const stop = async () => { await window.autoPrompt.stopRun(); setMessage("Stopping after the current safe checkpoint…") }
  const updateAction = async (action: "check" | "download" | "install") => {
    const result = action === "check" ? await window.autoPrompt.checkForUpdates() : action === "download" ? await window.autoPrompt.downloadUpdate() : await window.autoPrompt.installUpdate()
    if (!result.ok) setUpdateState((current) => ({ ...current, phase: "error", message: result.error }))
  }
  const openLogs = async () => {
    const result = await window.autoPrompt.openLogDirectory()
    if (!result.ok) setMessage(result.error)
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark">KA</div>
      <div className="brand-copy"><h1>Kuntyy AutoPrompt</h1><p>Google Flow automation</p></div>
      <nav className="app-tabs" aria-label="Application sections">
        <button className={view === "flow" ? "active" : ""} onClick={() => setView("flow")}>Google Flow</button>
        <button className={view === "docs" ? "active" : ""} onClick={() => setView("docs")}>Docs</button>
        <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Settings</button>
      </nav>
      <div className={`connection ${running ? "online" : ""}`}><i />{running ? "Queue running" : accountId ? "Ready" : "No account"}</div>
      <button className="update-menu-button" onClick={() => setUpdatesOpen(true)}><span>Updates</span>{updateState.phase === "available" || updateState.phase === "downloaded" ? <i /> : null}</button>
    </header>

    {view === "flow" && <main className="flow-layout">
      <aside className="setup-panel">
        <section>
          <div className="section-heading"><span>01</span><div><h2>Account</h2><p>FlowPilot session</p></div></div>
          <label>Google Flow account<select value={accountId} onChange={(event) => setAccountId(event.target.value)} disabled={running}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.email ? ` · ${account.email}` : ""}</option>)}</select></label>
          <p className="field-help">The latest signed-in session is loaded automatically when you run.</p>
        </section>
        <section>
          <div className="section-heading"><span>02</span><div><h2>Project</h2><p>Native Google Flow routing</p></div></div>
          <div className="segmented"><button className={projectMode === "recent" ? "active" : ""} onClick={() => setProjectMode("recent")} disabled={running}>Recent project</button><button className={projectMode === "new" ? "active" : ""} onClick={() => setProjectMode("new")} disabled={running}>Create project</button></div>
          {projectMode === "new" && <label>Project name <span className="optional">Optional</span><input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Campaign September" disabled={running} /></label>}
        </section>
        <section>
          <div className="section-heading"><span>03</span><div><h2>Output</h2><p>Native Flow settings</p></div></div>
          <div className="segmented"><button className={output === "image" ? "active" : ""} onClick={() => setOutput("image")} disabled={running}>Image</button><button className={output === "video" ? "active" : ""} onClick={() => setOutput("video")} disabled={running}>Video</button></div>
          <label>Model<select value={model} onChange={(event) => setModel(event.target.value)} disabled={running}>{models.map((value) => <option key={value}>{value}</option>)}</select></label>
          <div className="field-row"><label>Ratio<select value={ratio} onChange={(event) => setRatio(event.target.value as RunSettings["aspectRatio"])} disabled={running}>{ratios.map((value) => <option key={value}>{value}</option>)}</select></label><label>Variants<select value={variants} onChange={(event) => setVariants(Number(event.target.value) as 1 | 2 | 3)} disabled={running}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label></div>
          <label>Download quality<select value={quality} onChange={(event) => setQuality(event.target.value as DownloadQuality)} disabled={running}>{qualityOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        </section>
      </aside>

      <section className="workspace">
        <div className="workspace-head"><div><p className="eyebrow">Composition</p><h2>Prompt jobs</h2><p className="workspace-subtitle">Use <code>---</code> between prompts that share the same assets.</p></div><div className="head-actions"><button className="secondary" onClick={importPrompts} disabled={running}>Import TXT</button><button className="primary" onClick={() => setJobs((current) => [...current, createJob()])} disabled={running}>＋ Add more job</button></div></div>
        <div className="job-list">{jobs.map((job, index) => {
          const inherited = sharedAssets.filter((asset) => !job.assets.some((candidate) => candidate.id === asset.id))
          const count = parsePromptText(job.prompt).length
          return <article className={`job-card status-${job.status}`} key={job.id}>
            <div className="job-number">{String(index + 1).padStart(2, "0")}</div>
            <div className="job-body">
              <div className="job-title"><div><h3>Job group</h3><span className="prompt-count">{count} prompt{count === 1 ? "" : "s"}</span><span className="status-pill">{job.status}</span></div>{jobs.length > 1 && !running && <button className="icon-button" aria-label="Remove job" onClick={() => setJobs((current) => current.filter((item) => item.id !== job.id))}>×</button>}</div>
              <textarea value={job.prompt} disabled={running} onChange={(event) => updateJob(job.id, { prompt: event.target.value })} placeholder={"Describe what Flow should generate.\n\n---\n\nAdd another prompt with the same assets."} />
              <div className="job-assets-head"><div><strong>Assets</strong><span>{job.assets.length || inherited.length ? "Selected once and reused inside this job" : "Optional"}</span></div><button className="text-button" onClick={() => void addAssets(job.id)} disabled={running}>＋ Select assets</button></div>
              <AssetList assets={inherited} inherited canShare disabled={running} />
              <AssetList assets={job.assets} canShare={jobs.length > 1} disabled={running} onShare={(assetId, shared) => updateAsset(job.id, assetId, shared)} onRemove={(assetId) => updateJob(job.id, { assets: job.assets.filter((asset) => asset.id !== assetId) })} />
              {(running || job.progress > 0) && <div className="job-progress"><div style={{ width: `${job.progress}%` }} /></div>}
              {job.error && <p className="job-error">{job.error}</p>}
              {job.downloads.map((file) => <p className="downloaded" key={file}>Saved · {file}</p>)}
            </div>
          </article>
        })}</div>
      </section>

      <aside className="run-panel">
        <div><p className="eyebrow">Queue control</p><h2>Ready to run</h2><p className="run-summary">{jobs.length} job group{jobs.length === 1 ? "" : "s"} · {promptCount} prompt{promptCount === 1 ? "" : "s"}</p></div>
        <div className="summary-grid"><div><span>Output</span><strong>{output}</strong></div><div><span>Quality</span><strong>{quality.replaceAll("-", " ")}</strong></div><div><span>Completed</span><strong>{completed}/{jobs.length}</strong></div><div><span>Progress</span><strong>{progress}%</strong></div></div>
        <label className="toggle-row"><span><strong>Auto-download</strong><small>Save each variant when ready</small></span><input type="checkbox" checked={autoDownload} disabled={running} onChange={(event) => setAutoDownload(event.target.checked)} /></label>
        {autoDownload && <div className="folder"><span>{downloadDirectory || "No download folder selected"}</span><button onClick={chooseDirectory} disabled={running}>Choose</button></div>}
        <div className="message" role="status">{message}</div>
        {running ? <button className="danger full large" onClick={stop}>Stop queue</button> : <button className="run-button" onClick={start} disabled={!canRun}><span>Run queue</span><b>→</b></button>}
        {!canRun && !running && <p className="run-hint">Choose an account, add at least one prompt, and select a download folder when auto-download is enabled.</p>}
      </aside>
    </main>}

    {view === "docs" && <main className="content-page">
      <div className="page-heading"><p className="eyebrow">Docs</p><h2>Google Flow workflow</h2><p>Everything needed to prepare a queue without repeating setup.</p></div>
      <div className="docs-grid">
        <article><span>01</span><h3>Run without connecting first</h3><p>Select a FlowPilot account and press Run queue. Kuntyy AutoPrompt reads the signed-in session and opens Chrome automatically.</p></article>
        <article><span>02</span><h3>Choose the project route</h3><p>Recent project opens the first project in Google Flow's recent list. Create project uses the native New project action.</p></article>
        <article><span>03</span><h3>Bulk prompts</h3><p>Put <code>---</code> on its own line between prompts. Every prompt inside one job group uses the same job assets.</p></article>
        <article><span>04</span><h3>Hybrid assets</h3><p>Add another job when its local assets differ. With multiple jobs visible, mark an asset All jobs to reuse it without selecting or uploading it again.</p></article>
        <article><span>05</span><h3>TXT files</h3><p>TXT import accepts <code>---</code> separators. Blank-line-separated legacy files are normalized into one job group automatically.</p></article>
        <article><span>06</span><h3>Downloads</h3><p>Choose a folder before running. Each variant downloads as soon as it becomes ready; jobs do not wait for every variant to finish together.</p></article>
      </div>
    </main>}

    {view === "settings" && <main className="content-page settings-page">
      <div className="page-heading"><p className="eyebrow">Settings</p><h2>Application</h2><p>Update and runtime information for this installation.</p></div>
      <section className="settings-card"><div><span>Installed version</span><strong>v{updateState.currentVersion}</strong><p>{updateState.message}</p></div><button className="secondary" onClick={() => setUpdatesOpen(true)}>Open updates</button></section>
      <section className="settings-card"><div><span>Diagnostic logs</span><strong className="path-value" title={logDirectory}>{logDirectory}</strong><p>Startup, automation, updater, and crash diagnostics are stored beside the installed application.</p></div><button className="secondary" onClick={() => void openLogs()}>Open logs folder</button></section>
      <section className="settings-card"><div><span>Automation browser</span><strong>Local Google Chrome</strong><p>Chrome is opened only when a queue starts and is reused for later runs on the same account.</p></div></section>
      <section className="settings-card"><div><span>Session source</span><strong>FlowPilot WebView2</strong><p>Automation attaches to the selected FlowPilot session directly. Cookies and browser storage are not copied into another profile.</p></div></section>
    </main>}

    {updatesOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setUpdatesOpen(false) }}>
      <section className="update-modal" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <div className="update-modal-head"><div><p className="eyebrow">Application</p><h2 id="update-title">Updates</h2></div><button className="icon-button" aria-label="Close updates" onClick={() => setUpdatesOpen(false)}>×</button></div>
        <div className="version-row"><span>Installed version</span><strong>v{updateState.currentVersion}</strong></div>
        {updateState.availableVersion && <div className="version-row"><span>Available version</span><strong>v{updateState.availableVersion}</strong></div>}
        <div className={`update-status phase-${updateState.phase}`}><i /><div><strong>{updateState.phase.replaceAll("-", " ")}</strong><p>{updateState.message}</p></div></div>
        {updateState.phase === "downloading" && <div className="update-progress"><div style={{ width: `${updateState.percent || 0}%` }} /></div>}
        <div className="update-actions">
          {(updateState.phase === "idle" || updateState.phase === "up-to-date" || updateState.phase === "error") && <button className="secondary" onClick={() => void updateAction("check")}>Check for updates</button>}
          {updateState.phase === "available" && <button className="primary" onClick={() => void updateAction("download")}>Download v{updateState.availableVersion}</button>}
          {updateState.phase === "downloaded" && <button className="primary" onClick={() => void updateAction("install")}>Restart and install</button>}
          {updateState.phase === "checking" && <button className="secondary" disabled>Checking…</button>}
          {updateState.phase === "downloading" && <button className="secondary" disabled>Downloading {updateState.percent || 0}%</button>}
          {updateState.phase === "installing" && <button className="secondary" disabled>Installing…</button>}
          {updateState.phase === "restarting" && <button className="secondary" disabled>Restarting…</button>}
        </div>
        <div className="patch-log">
          <div className="patch-log-heading"><span>Patch log</span><strong>Next update</strong></div>
          <ul>{NEXT_UPDATE_PATCHES.map((item) => <li key={item}>{item}</li>)}</ul>
          {PATCH_LOG.map((entry) => <details key={entry.version}><summary><span>v{entry.version}</span><strong>{entry.title}</strong></summary><ul>{entry.items.map((item) => <li key={item}>{item}</li>)}</ul></details>)}
        </div>
        <p className="update-note">Updates install over the current version. Your local FlowPilot sessions, queue settings, and downloaded files are not removed.</p>
      </section>
    </div>}
  </div>
}
