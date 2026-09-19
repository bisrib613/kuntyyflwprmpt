import type { ApiVaultAsset, ApiVaultConversation, ApiVaultRequest, ApiVaultResponse, ApiVaultSettings } from "./api-vault.js"

export type OutputKind = "image" | "video"
export type ImageQuality = "original-1k" | "upscale-2k" | "upscale-4k"
export type VideoQuality = "original-720p" | "upscale-1080p" | "upscale-4k" | "gif-270p"
export type DownloadQuality = ImageQuality | VideoQuality
export type AspectRatio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16"
export type VideoDuration = 4 | 6 | 8 | 10
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
  videoDuration: VideoDuration
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
  pickApiVaultAssets(): Promise<ApiResult<ApiVaultAsset[]>>
  pickApiVaultTextFile(): Promise<ApiResult<{ name: string; text: string } | null>>
  runApiVault(request: ApiVaultRequest): Promise<ApiResult<ApiVaultResponse>>
  listApiVaultConversations(): Promise<ApiResult<ApiVaultConversation[]>>
  deleteApiVaultConversation(id: string): Promise<ApiResult<void>>
  loadApiVaultSettings(): Promise<ApiResult<ApiVaultSettings | null>>
  saveApiVaultSettings(settings: ApiVaultSettings): Promise<ApiResult<void>>
  listApiVaultModels(provider: ApiVaultRequest["provider"], endpoint: string, apiKey: string): Promise<ApiResult<string[]>>
  saveApiVaultResult(directory: string, filename: string, content: string, format: "txt" | "json"): Promise<ApiResult<string>>
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
