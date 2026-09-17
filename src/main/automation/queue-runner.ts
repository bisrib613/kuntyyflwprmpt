import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import type { BrowserCookie, FlowpilotAccount, QueueEvent, RunSettings } from "../../shared/contracts.js"
import { FlowController } from "./flow-controller.js"

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
    if (!this.controller) this.controller = await FlowController.launch(this.profileDirectory, this.cookies)
    return this.controller
  }

  stop(): void { this.cancelled = true }

  get isRunning(): boolean { return this.running }

  async run(settings: RunSettings): Promise<void> {
    if (this.running) throw new Error("A queue is already running for this session.")
    this.running = true
    this.cancelled = false
    this.runId = randomUUID()
    try {
      const controller = await this.connect()
      this.emit({ runId: this.runId, status: "ready", message: `Connected to ${this.account.name}.` })
      const project = await controller.openProject(settings)
      await controller.configure(settings)
      await controller.prepareGlobalAssets(settings.globalAssets)
      this.emit({ runId: this.runId, status: "ready", message: `Using project ${project.name}.` })

      for (let index = 0; index < settings.jobs.length; index += 1) {
        const job = settings.jobs[index]
        if (this.cancelled) break
        this.emit({ runId: this.runId, jobId: job.id, status: "submitting", progress: 5, message: "Submitting prompt." })
        try {
          const previousKeys = await controller.submitJob(job, settings.globalAssets)
          this.emit({ runId: this.runId, jobId: job.id, status: "generating", progress: 20, message: `Waiting for ${settings.variants} variant(s).` })
          const downloads: string[] = []
          const downloadTasks: Array<Promise<void>> = []
          const slots: Array<Promise<void>> = [Promise.resolve(), Promise.resolve()]
          await controller.watchNewCards(previousKeys, settings.variants, (card) => {
            if (!settings.autoDownload || this.cancelled) return
            this.emit({ runId: this.runId, jobId: job.id, status: "downloading", progress: 40 + Math.round((card.index / settings.variants) * 50), message: `Variant ${card.index + 1} is ready; downloading now.` })
            const slot = card.index % slots.length
            const task = slots[slot].then(async () => { downloads.push(await controller.downloadCard(card, settings, index)) })
            slots[slot] = task
            downloadTasks.push(task)
          })
          await Promise.all(downloadTasks)
          this.emit({ runId: this.runId, jobId: job.id, status: "completed", progress: 100, downloads, message: "Job completed." })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.emit({ runId: this.runId, jobId: job.id, status: "failed", message })
        }
      }
      this.emit({ runId: this.runId, status: "stopped", message: this.cancelled ? "Queue stopped." : "Queue finished." })
    } finally {
      this.running = false
    }
  }

  async close(): Promise<void> {
    try {
      await this.controller?.close()
    } finally {
      this.controller = null
      await rm(this.profileDirectory, { recursive: true, force: true })
    }
  }
}
