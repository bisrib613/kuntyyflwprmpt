export type OutputKind = "image" | "video"
export type ImageQuality = "original-1k" | "upscale-2k" | "upscale-4k"
export type VideoQuality = "original-720p" | "upscale-1080p" | "upscale-4k" | "gif-270p"
export type DownloadQuality = ImageQuality | VideoQuality
export type AspectRatio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16"
export type JobStatus = "draft" | "queued" | "submitting" | "generating" | "downloading" | "completed" | "failed" | "cancelled"

export type FlowpilotAccount = {
  id: string
  name: string
  email: string | null
}

export type PreparedFlowpilotSession = {
  cdpEndpoint: string
}

export type AssetInput = {
  id: string
  path: string
  name: string
  shared?: boolean
}

export type PromptJob = {
  id: string
  prompt: string
  assets: AssetInput[]
  status: JobStatus
  progress: number
  error?: string
  downloads: string[]
}

export type RunSettings = {
  accountId: string
  projectMode: "recent" | "new"
  newProjectName?: string
  output: OutputKind
  model: string
  aspectRatio: AspectRatio
  variants: 1 | 2 | 3
  quality: DownloadQuality
  autoDownload: boolean
  downloadDirectory: string
  jobs: PromptJob[]
}

export type QueueEvent = {
  runId: string
  jobId?: string
  status: JobStatus | "ready" | "stopped"
  progress?: number
  message: string
  downloads?: string[]
}

export type UpdatePhase = "idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "installing" | "restarting" | "error"

export type UpdateState = {
  currentVersion: string
  phase: UpdatePhase
  availableVersion?: string
  percent?: number
  transferred?: number
  total?: number
  message: string
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type AutoPromptApi = {
  listAccounts(): Promise<ApiResult<FlowpilotAccount[]>>
  pickAssets(): Promise<ApiResult<AssetInput[]>>
  pickPromptFile(): Promise<ApiResult<{ name: string; text: string } | null>>
  pickDownloadDirectory(): Promise<ApiResult<string | null>>
  getLogDirectory(): Promise<ApiResult<string>>
  openLogDirectory(): Promise<ApiResult<void>>
  startRun(settings: RunSettings): Promise<ApiResult<{ runId: string }>>
  stopRun(): Promise<ApiResult<void>>
  onQueueEvent(listener: (event: QueueEvent) => void): () => void
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<ApiResult<void>>
  downloadUpdate(): Promise<ApiResult<void>>
  installUpdate(): Promise<ApiResult<void>>
  onUpdateState(listener: (state: UpdateState) => void): () => void
}

declare global {
  interface Window { autoPrompt: AutoPromptApi }
}
