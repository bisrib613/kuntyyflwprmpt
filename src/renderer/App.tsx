import { useEffect, useMemo, useState } from "react"
import "./bridge"
import type { AssetInput, DownloadQuality, FlowProject, FlowpilotAccount, OutputKind, PromptJob, QueueEvent, RunSettings, UpdateState } from "../shared/contracts"
import { NEXT_UPDATE_PATCHES, PATCH_LOG } from "../shared/patch-log"
import { parsePromptFile } from "../shared/prompt-file"

const IMAGE_MODELS = ["Nano Banana 2 Lite", "Nano Banana 2", "Nano Banana Pro"]
const VIDEO_MODELS = ["Omni 1.1 Flash", "Veo 3.1 Lite", "Veo 3.1 Fast", "Veo 3.1 Quality"]
const IMAGE_QUALITIES: Array<[DownloadQuality, string]> = [["original-1k", "Original 1K"], ["upscale-2k", "2K Upscaled"], ["upscale-4k", "4K · fallback 2K"]]
const VIDEO_QUALITIES: Array<[DownloadQuality, string]> = [["original-720p", "Original 720p"], ["upscale-1080p", "1080p · fallback 720p"], ["upscale-4k", "4K · fallback 1080p / 720p"], ["gif-270p", "Animated GIF 270p"]]

function createJob(prompt = ""): PromptJob {
  return { id: crypto.randomUUID(), prompt, useGlobalAssets: true, assets: [], status: "draft", progress: 0, downloads: [] }
}

function AssetList({ assets, onRemove }: { assets: AssetInput[]; onRemove: (id: string) => void }) {
  if (!assets.length) return <p className="empty-inline">No assets selected.</p>
  return <div className="asset-list">{assets.map((asset) => <span className="asset-chip" key={asset.id}><span>{asset.name}</span><button aria-label={`Remove ${asset.name}`} onClick={() => onRemove(asset.id)}>×</button></span>)}</div>
}

export function App() {
  const [accounts, setAccounts] = useState<FlowpilotAccount[]>([])
  const [accountId, setAccountId] = useState("")
  const [projects, setProjects] = useState<FlowProject[]>([])
  const [projectChoice, setProjectChoice] = useState("")
  const [newProjectName, setNewProjectName] = useState("")
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [output, setOutput] = useState<OutputKind>("image")
  const [model, setModel] = useState(IMAGE_MODELS[0])
  const [ratio, setRatio] = useState<RunSettings["aspectRatio"]>("16:9")
  const [variants, setVariants] = useState<1 | 2 | 3>(1)
  const [quality, setQuality] = useState<DownloadQuality>("original-1k")
  const [autoDownload, setAutoDownload] = useState(true)
  const [downloadDirectory, setDownloadDirectory] = useState("")
  const [globalAssets, setGlobalAssets] = useState<AssetInput[]>([])
  const [jobs, setJobs] = useState<PromptJob[]>([createJob()])
  const [message, setMessage] = useState("Load a FlowPilot session to begin.")
  const [running, setRunning] = useState(false)
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState>({ currentVersion: "0.1.0", phase: "idle", message: "Updates are checked automatically." })

  useEffect(() => {
    void window.autoPrompt.listAccounts().then((result) => {
      if (!result.ok) return setMessage(result.error)
      setAccounts(result.value)
      if (result.value[0]) setAccountId(result.value[0].id)
      if (!result.value.length) setMessage("No signed-in Google Flow profiles were found in FlowPilot.")
    })
    void window.autoPrompt.getUpdateState().then(setUpdateState)
    const updateTimer = window.setTimeout(() => { void window.autoPrompt.checkForUpdates() }, 15_000)
    const stopQueueEvents = window.autoPrompt.onQueueEvent((event: QueueEvent) => {
      setMessage(event.message)
      if (event.jobId) setJobs((current) => current.map((job) => job.id === event.jobId ? { ...job, status: event.status as PromptJob["status"], progress: event.progress ?? job.progress, downloads: event.downloads ?? job.downloads, error: event.status === "failed" ? event.message : undefined } : job))
      if (event.status === "stopped") setRunning(false)
    })
    const stopUpdateEvents = window.autoPrompt.onUpdateState(setUpdateState)
    return () => { window.clearTimeout(updateTimer); stopQueueEvents(); stopUpdateEvents() }
  }, [])

  useEffect(() => {
    setConnected(false); setProjects([]); setProjectChoice("")
  }, [accountId])

  const qualityOptions = output === "image" ? IMAGE_QUALITIES : VIDEO_QUALITIES
  const models = output === "image" ? IMAGE_MODELS : VIDEO_MODELS
  const ratios = output === "image" ? ["16:9", "4:3", "1:1", "3:4", "9:16"] as const : ["16:9", "9:16"] as const
  const completed = jobs.filter((job) => job.status === "completed").length
  const progress = jobs.length ? Math.round(jobs.reduce((sum, job) => sum + job.progress, 0) / jobs.length) : 0
  const canRun = connected && Boolean(projectChoice) && jobs.length > 0 && jobs.every((job) => job.prompt.trim()) && (!autoDownload || Boolean(downloadDirectory)) && !running

  useEffect(() => {
    const nextModels = output === "image" ? IMAGE_MODELS : VIDEO_MODELS
    setModel(nextModels[0])
    setQuality(output === "image" ? "original-1k" : "original-720p")
    if (output === "video" && !["16:9", "9:16"].includes(ratio)) setRatio("16:9")
  }, [output])

  const connect = async () => {
    if (!accountId) return
    setConnecting(true); setMessage("Reading the FlowPilot sign-in session…")
    const result = await window.autoPrompt.connect(accountId)
    setConnecting(false)
    if (!result.ok) return setMessage(result.error)
    setProjects(result.value); setConnected(true)
    const remembered = localStorage.getItem(`project:${accountId}`)
    const choice = result.value.some((project) => project.id === remembered) ? remembered! : result.value[0]?.id || "__new__"
    setProjectChoice(choice); setMessage(`Connected. ${result.value.length} project(s) available.`)
  }

  const addAssets = async (scope: "global" | string) => {
    const result = await window.autoPrompt.pickAssets()
    if (!result.ok) return setMessage(result.error)
    if (scope === "global") setGlobalAssets((current) => [...current, ...result.value])
    else setJobs((current) => current.map((job) => job.id === scope ? { ...job, assets: [...job.assets, ...result.value] } : job))
  }

  const importPrompts = async () => {
    const result = await window.autoPrompt.pickPromptFile()
    if (!result.ok) return setMessage(result.error)
    if (!result.value) return
    const prompts = parsePromptFile(result.value.text)
    if (!prompts.length) return setMessage(`${result.value.name} did not contain any prompts.`)
    setJobs(prompts.map(createJob)); setMessage(`Imported ${prompts.length} prompt(s) from ${result.value.name}.`)
  }

  const chooseDirectory = async () => {
    const result = await window.autoPrompt.pickDownloadDirectory()
    if (!result.ok) return setMessage(result.error)
    if (result.value) setDownloadDirectory(result.value)
  }

  const updateJob = (id: string, patch: Partial<PromptJob>) => setJobs((current) => current.map((job) => job.id === id ? { ...job, ...patch } : job))

  const start = async () => {
    const selected = projects.find((project) => project.id === projectChoice)
    const settings: RunSettings = {
      accountId,
      projectMode: projectChoice === "__new__" ? "new" : "existing",
      projectId: selected?.id,
      newProjectName,
      output,
      model,
      aspectRatio: ratio,
      variants,
      quality,
      autoDownload,
      downloadDirectory,
      globalAssets,
      jobs: jobs.map((job) => ({ ...job, status: "queued", progress: 0, downloads: [], error: undefined })),
    }
    setJobs(settings.jobs); setRunning(true); setMessage("Starting queue…")
    if (selected) localStorage.setItem(`project:${accountId}`, selected.id)
    const result = await window.autoPrompt.startRun(settings)
    if (!result.ok) { setRunning(false); setMessage(result.error) }
  }

  const stop = async () => { await window.autoPrompt.stopRun(); setMessage("Stopping after the current safe checkpoint…") }

  const updateAction = async (action: "check" | "download" | "install") => {
    const result = action === "check" ? await window.autoPrompt.checkForUpdates() : action === "download" ? await window.autoPrompt.downloadUpdate() : await window.autoPrompt.installUpdate()
    if (!result.ok) setUpdateState((current) => ({ ...current, phase: "error", message: result.error }))
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark">KA</div>
      <div><h1>Kuntyy AutoPrompt</h1><p>Google Flow queue runner</p></div>
      <div className={`connection ${connected ? "online" : ""}`}><i />{connected ? "Session ready" : "Not connected"}</div>
      <button className="update-menu-button" onClick={() => setUpdatesOpen(true)}><span>Updates</span>{updateState.phase === "available" || updateState.phase === "downloaded" ? <i /> : null}</button>
    </header>

    <main>
      <aside className="setup-panel">
        <section>
          <div className="section-heading"><span>01</span><div><h2>Session</h2><p>Local FlowPilot profile</p></div></div>
          <label>Google Flow account<select value={accountId} onChange={(event) => setAccountId(event.target.value)} disabled={running}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.email ? ` · ${account.email}` : ""}</option>)}</select></label>
          <button className="secondary full" onClick={connect} disabled={!accountId || connecting || running}>{connecting ? "Connecting…" : connected ? "Reconnect session" : "Connect session"}</button>
        </section>

        <section className={!connected ? "muted-section" : ""}>
          <div className="section-heading"><span>02</span><div><h2>Project</h2><p>One project per run</p></div></div>
          <label>Destination<select value={projectChoice} disabled={!connected || running} onChange={(event) => setProjectChoice(event.target.value)}><option value="" disabled>Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}<option value="__new__">＋ Create new project</option></select></label>
          {projectChoice === "__new__" && <label>New project name<input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Campaign September" /></label>}
        </section>

        <section className={!connected ? "muted-section" : ""}>
          <div className="section-heading"><span>03</span><div><h2>Output</h2><p>Native Flow settings</p></div></div>
          <div className="segmented"><button className={output === "image" ? "active" : ""} onClick={() => setOutput("image")}>Image</button><button className={output === "video" ? "active" : ""} onClick={() => setOutput("video")}>Video</button></div>
          <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((value) => <option key={value}>{value}</option>)}</select></label>
          <div className="field-row"><label>Ratio<select value={ratio} onChange={(event) => setRatio(event.target.value as RunSettings["aspectRatio"])}>{ratios.map((value) => <option key={value}>{value}</option>)}</select></label><label>Variants<select value={variants} onChange={(event) => setVariants(Number(event.target.value) as 1 | 2 | 3)}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label></div>
          <label>Download quality<select value={quality} onChange={(event) => setQuality(event.target.value as DownloadQuality)}>{qualityOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        </section>
      </aside>

      <section className="workspace">
        <div className="workspace-head"><div><p className="eyebrow">Run composition</p><h2>Prompt jobs</h2></div><div className="head-actions"><button className="secondary" onClick={importPrompts} disabled={running}>Import TXT</button><button className="primary" onClick={() => setJobs((current) => [...current, createJob()])} disabled={running}>＋ Add job</button></div></div>

        <section className="global-assets">
          <div><span className="asset-icon">◎</span><div><h3>Global assets</h3><p>Uploaded once, available to jobs that opt in.</p></div></div>
          <button className="secondary" onClick={() => void addAssets("global")} disabled={running}>Select assets</button>
          <AssetList assets={globalAssets} onRemove={(id) => setGlobalAssets((current) => current.filter((asset) => asset.id !== id))} />
        </section>

        <div className="job-list">{jobs.map((job, index) => <article className={`job-card status-${job.status}`} key={job.id}>
          <div className="job-number">{String(index + 1).padStart(2, "0")}</div>
          <div className="job-body">
            <div className="job-title"><div><h3>Prompt job</h3><span className="status-pill">{job.status}</span></div>{jobs.length > 1 && !running && <button className="icon-button" aria-label="Remove job" onClick={() => setJobs((current) => current.filter((item) => item.id !== job.id))}>×</button>}</div>
            <textarea value={job.prompt} disabled={running} onChange={(event) => updateJob(job.id, { prompt: event.target.value })} placeholder="Describe the image or video you want Flow to generate…" />
            <div className="job-options"><label className="check"><input type="checkbox" checked={job.useGlobalAssets} disabled={!globalAssets.length || running} onChange={(event) => updateJob(job.id, { useGlobalAssets: event.target.checked })} /><span>Use global assets</span></label><button className="text-button" onClick={() => void addAssets(job.id)} disabled={running}>＋ Job-specific assets</button></div>
            <AssetList assets={job.assets} onRemove={(id) => updateJob(job.id, { assets: job.assets.filter((asset) => asset.id !== id) })} />
            {(running || job.progress > 0) && <div className="job-progress"><div style={{ width: `${job.progress}%` }} /></div>}
            {job.error && <p className="job-error">{job.error}</p>}
            {job.downloads.map((file) => <p className="downloaded" key={file}>Saved · {file}</p>)}
          </div>
        </article>)}</div>
      </section>

      <aside className="run-panel">
        <div><p className="eyebrow">Queue control</p><h2>Ready to run</h2><p className="run-summary">{jobs.length} job{jobs.length === 1 ? "" : "s"} · {variants} variant{variants === 1 ? "" : "s"} each</p></div>
        <div className="summary-grid"><div><span>Output</span><strong>{output}</strong></div><div><span>Quality</span><strong>{quality.replaceAll("-", " ")}</strong></div><div><span>Completed</span><strong>{completed}/{jobs.length}</strong></div><div><span>Progress</span><strong>{progress}%</strong></div></div>
        <label className="toggle-row"><span><strong>Auto-download</strong><small>Save each variant when ready</small></span><input type="checkbox" checked={autoDownload} onChange={(event) => setAutoDownload(event.target.checked)} /></label>
        {autoDownload && <div className="folder"><span>{downloadDirectory || "No download folder selected"}</span><button onClick={chooseDirectory}>Choose</button></div>}
        <div className="message" role="status">{message}</div>
        {running ? <button className="danger full large" onClick={stop}>Stop queue</button> : <button className="run-button" onClick={start} disabled={!canRun}><span>Run queue</span><b>→</b></button>}
        {!canRun && !running && <p className="run-hint">Connect an account, select a project, fill every prompt, and choose a download folder.</p>}
      </aside>
    </main>
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
        </div>
        <div className="patch-log">
          <div className="patch-log-heading"><span>Patch log</span><strong>Next update</strong></div>
          <ul>{NEXT_UPDATE_PATCHES.map((item) => <li key={item}>{item}</li>)}</ul>
          {PATCH_LOG.map((entry) => <details key={entry.version}>
            <summary><span>v{entry.version}</span><strong>{entry.title}</strong></summary>
            <ul>{entry.items.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>)}
        </div>
        <p className="update-note">Updates install over the current version. Your local FlowPilot sessions, projects, queue settings, and downloaded files are not removed.</p>
      </section>
    </div>}
  </div>
}
