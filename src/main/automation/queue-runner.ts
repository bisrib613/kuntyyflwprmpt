import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import type { BrowserCookie, FlowpilotAccount, QueueEvent, RunSettings } from "../../shared/contracts.js"
import { parsePromptText } from "../../shared/prompt-file.js"
import { FlowController } from "./flow-controller.js"
import { logAutomation } from "../../sidecar/logger.js"

export class QueueRunner {
  private controller: FlowController | null = null
  private cancelled = false
  private running = false
  runId = randomUUID()

  constructor(
    private readonly account: FlowpilotAccount,
    private readonly profileDirectory: string,
    private readonly cookies: BrowserCookie[],
    private readonly emit: (event: QueueEvent) => void,
  ) {}

  async connect(): Promise<FlowController> {
    if (!this.controller) {
      logAutomation("runner.connect.start", { accountId: this.account.id })
      this.controller = await FlowController.launch(this.profileDirectory, this.cookies)
      logAutomation("runner.connect.complete", { accountId: this.account.id })
    }
    return this.controller
  }

  stop(): void { this.cancelled = true }

  get isRunning(): boolean { return this.running }

  async run(settings: RunSettings): Promise<void> {
    if (this.running) throw new Error("A queue is already running for this session.")
    this.running = true
    this.cancelled = false
    this.runId = randomUUID()
    logAutomation("runner.run.start", { runId: this.runId, accountId: this.account.id, projectMode: settings.projectMode, jobCount: settings.jobs.length })
    try {
      const controller = await this.connect()
      this.emit({ runId: this.runId, status: "ready", message: `Connected to ${this.account.name}.` })
      const project = await controller.openProject(settings)
      await controller.configure(settings)
      const allAssets = settings.jobs.flatMap((job) => job.assets)
      const uniqueAssets = [...new Map(allAssets.map((asset) => [asset.id, asset])).values()]
      const sharedAssets = uniqueAssets.filter((asset) => asset.shared)
      await controller.prepareAssets(uniqueAssets)
      this.emit({ runId: this.runId, status: "ready", message: `Using project ${project.name}.` })

      for (let index = 0; index < settings.jobs.length; index += 1) {
        const job = settings.jobs[index]
        const prompts = parsePromptText(job.prompt)
        if (this.cancelled) break
        try {
          const downloads: string[] = []
          for (let promptIndex = 0; promptIndex < prompts.length; promptIndex += 1) {
            if (this.cancelled) break
            const promptNumber = promptIndex + 1
            const baseProgress = Math.round((promptIndex / prompts.length) * 100)
            this.emit({ runId: this.runId, jobId: job.id, status: "submitting", progress: baseProgress, message: `Submitting prompt ${promptNumber}/${prompts.length}.` })
            const runtimeJob = { ...job, prompt: prompts[promptIndex] }
            const previousKeys = await controller.submitJob(runtimeJob, sharedAssets)
            this.emit({ runId: this.runId, jobId: job.id, status: "generating", progress: baseProgress + Math.round(20 / prompts.length), message: `Prompt ${promptNumber}/${prompts.length}: waiting for ${settings.variants} variant(s).` })
            const downloadTasks: Array<Promise<void>> = []
            const slots: Array<Promise<void>> = [Promise.resolve(), Promise.resolve()]
            await controller.watchNewCards(previousKeys, settings.variants, (card) => {
              if (!settings.autoDownload || this.cancelled) return
              const withinPrompt = 40 + Math.round((card.index / settings.variants) * 50)
              const combinedProgress = Math.min(99, Math.round(((promptIndex * 100) + withinPrompt) / prompts.length))
              this.emit({ runId: this.runId, jobId: job.id, status: "downloading", progress: combinedProgress, message: `Prompt ${promptNumber}/${prompts.length}, variant ${card.index + 1}: downloading.` })
              const slot = card.index % slots.length
              const task = slots[slot].then(async () => { downloads.push(await controller.downloadCard(card, settings, index, promptIndex)) })
              slots[slot] = task
              downloadTasks.push(task)
            })
            await Promise.all(downloadTasks)
          }
          this.emit({ runId: this.runId, jobId: job.id, status: "completed", progress: 100, downloads, message: "Job completed." })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.emit({ runId: this.runId, jobId: job.id, status: "failed", message })
        }
      }
      this.emit({ runId: this.runId, status: "stopped", message: this.cancelled ? "Queue stopped." : "Queue finished." })
      logAutomation("runner.run.complete", { runId: this.runId, cancelled: this.cancelled })
    } finally {
      this.running = false
    }
  }

  async close(): Promise<void> {
    logAutomation("runner.close.start", { accountId: this.account.id })
    try {
      await this.controller?.close()
    } finally {
      this.controller = null
      await rm(this.profileDirectory, { recursive: true, force: true })
      logAutomation("runner.close.complete", { accountId: this.account.id })
    }
  }
}
