import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core"
import type { AssetInput, BrowserCookie, OutputKind, PromptJob, RunSettings } from "../../shared/contracts.js"
import { qualityFallbacks, qualityMenuLabel } from "../../shared/quality.js"
import { flowSelectors } from "./selectors.js"

type OutputCard = { locator: Locator; index: number }
type ActiveProject = { id: string; name: string }

const sanitize = (value: string) => value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").slice(0, 120) || "output"

export class FlowController {
  private readonly assetRefs = new Map<string, string>()
  private activeProjectId: string | null = null
  private constructor(private readonly context: BrowserContext, private readonly page: Page) {}

  static async launch(profileDirectory: string, cookies: BrowserCookie[]): Promise<FlowController> {
    const context = await chromium.launchPersistentContext(profileDirectory, {
      channel: "chrome",
      headless: false,
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
    })
    await context.addCookies(cookies)
    const page = context.pages()[0] || await context.newPage()
    return new FlowController(context, page)
  }

  async close(): Promise<void> { await this.context.close() }

  private async openFlowHome(): Promise<void> {
    await this.page.goto("https://flow.google.com/", { waitUntil: "domcontentloaded" })
    if (this.page.url().includes("accounts.google.com")) throw new Error("The selected FlowPilot session is signed out. Open this account in FlowPilot and sign in first.")
  }

  private useProject(id: string): void {
    if (this.activeProjectId !== id) this.assetRefs.clear()
    this.activeProjectId = id
  }

  async openProject(settings: RunSettings): Promise<ActiveProject> {
    await this.openFlowHome()
    if (settings.projectMode === "new") {
      const create = this.page.getByRole("button", { name: /New project/i })
      await create.waitFor({ state: "visible", timeout: 20_000 })
      await create.click()
      await this.page.waitForURL(/\/project\/[^/?#]+/, { timeout: 20_000 })
      const id = this.page.url().match(/\/project\/([^/?#]+)/)?.[1]
      if (!id) throw new Error("Flow created a project but its project id could not be read.")
      const name = settings.newProjectName?.trim()
      if (name) {
        const title = this.page.getByLabel("Editable text").first()
        if (await title.isVisible()) { await title.fill(name); await title.press("Enter") }
      }
      this.useProject(id)
      return { id, name: name || "New project" }
    }

    const recent = this.page.locator(flowSelectors.recentProject).filter({ visible: true }).first()
    await recent.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
      throw new Error("No recent Google Flow project is available. Choose Create project for the first run.")
    })
    const href = await recent.getAttribute("href")
    const id = href?.match(/\/project\/([^/?#]+)/)?.[1]
    if (!href || !id) throw new Error("Google Flow exposed a recent project without a valid project link.")
    const name = ((await recent.locator("xpath=..").textContent()) || "Recent project").replace(/edit|delete/gi, " ").replace(/\s+/g, " ").trim()
    await recent.click()
    await this.page.waitForURL(new RegExp(`/project/${id}(?:[/?#]|$)`), { timeout: 20_000 })
    this.useProject(id)
    return { id, name: name || "Recent project" }
  }

  async configure(settings: RunSettings): Promise<void> {
    await this.page.locator(flowSelectors.settings).click()
    await this.page.getByRole("radio", { name: settings.output === "image" ? /Image/i : /Video/i }).click()
    await this.page.getByRole("radio", { name: new RegExp(settings.aspectRatio.replace(":", "\\s*:\\s*")) }).click()
    const modelTrigger = this.page.getByLabel("Select model family")
    if (await modelTrigger.isVisible()) {
      await modelTrigger.click()
      const model = this.page.getByText(settings.model, { exact: true })
      if (await model.count()) await model.click()
    }
    await this.page.getByRole("radio", { name: `x${settings.variants}`, exact: true }).click()
    await this.page.locator(flowSelectors.settings).press("Escape")
  }

  async submitJob(job: PromptJob, sharedAssets: AssetInput[]): Promise<Set<string>> {
    const before = new Set(await this.cardKeys())
    const assets = [...sharedAssets, ...job.assets.filter((asset) => !asset.shared)]
    if (assets.length) {
      await this.attachAssets(assets)
    }
    const prompt = this.page.locator(flowSelectors.prompt).last()
    await prompt.fill(job.prompt)
    await this.page.locator(flowSelectors.startGeneration).click()
    return before
  }

  async prepareAssets(assets: AssetInput[]): Promise<void> {
    const missing = assets.filter((asset) => !this.assetRefs.has(asset.id))
    if (!missing.length) return
    await this.page.locator(flowSelectors.assetPicker).click()
    for (const asset of missing) {
      const identity = await this.uploadOneAsset(asset)
      this.assetRefs.set(asset.id, identity)
    }
    await this.page.locator(flowSelectors.assetPicker).click()
  }

  private async attachAssets(assets: AssetInput[]): Promise<void> {
    await this.page.locator(flowSelectors.assetPicker).click()
    const wanted = new Set(assets.map((asset) => this.assetRefs.get(asset.id)).filter((identity): identity is string => Boolean(identity)))
    const options = this.page.getByRole("option")
    for (let index = 0; index < await options.count(); index += 1) {
      const option = options.nth(index)
      if ((await option.getAttribute("aria-selected")) !== "true") continue
      const image = option.locator("img.asset-thumbnail-image")
      if (!await image.count()) continue
      const source = await image.evaluate((element) => (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src)
      if (!wanted.has(this.assetIdentity(source))) await option.click()
    }
    for (const asset of assets) {
      const identity = this.assetRefs.get(asset.id)
      if (!identity) throw new Error(`Asset ${asset.name} was not registered in the Flow project.`)
      const option = await this.findAssetOption(identity)
      if (!option) throw new Error(`Asset ${asset.name} is no longer available in the Flow asset picker.`)
      if ((await option.getAttribute("aria-selected")) !== "true") await option.click()
    }
    const add = this.page.getByRole("button", { name: /Add to prompt/i })
    await add.waitFor({ state: "visible", timeout: 30_000 })
    await add.click()
  }

  private assetIdentity(source: string): string {
    const url = new URL(source)
    return url.hostname === "flow-content.google" ? `${url.origin}${url.pathname}` : source
  }

  private async pickerAssetIdentities(): Promise<string[]> {
    const sources = await this.page.getByRole("option").locator("img.asset-thumbnail-image").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src).filter(Boolean))
    return sources.map((source) => this.assetIdentity(source))
  }

  private async uploadOneAsset(asset: AssetInput): Promise<string> {
    const before = new Set(await this.pickerAssetIdentities())
    const chooserPromise = this.page.waitForEvent("filechooser")
    await this.page.getByRole("button", { name: /Upload media/i }).click()
    const chooser = await chooserPromise
    await chooser.setFiles(asset.path)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const after = await this.pickerAssetIdentities()
      const identity = after.find((candidate) => !before.has(candidate))
      if (identity) return identity
      await this.page.waitForTimeout(500)
    }
    throw new Error(`Flow did not expose an identity for uploaded asset ${asset.name}.`)
  }

  private async findAssetOption(identity: string): Promise<Locator | null> {
    const options = this.page.getByRole("option")
    for (let index = 0; index < await options.count(); index += 1) {
      const option = options.nth(index)
      const image = option.locator("img.asset-thumbnail-image")
      if (!await image.count()) continue
      const source = await image.evaluate((element) => (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src)
      if (this.assetIdentity(source) === identity) return option
    }
    return null
  }

  private async cardKey(tile: Locator): Promise<string | null> {
    const image = tile.locator("img").first()
    if (!await image.count()) return null
    return image.evaluate((element) => {
      const mediaId = element.getAttribute("data-media-id")
      if (mediaId) return `media:${mediaId}`
      const source = (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src
      return source ? `thumbnail:${source}` : null
    })
  }

  private async cardKeys(): Promise<string[]> {
    const tiles = this.page.locator(flowSelectors.resultTile)
    const keys: string[] = []
    for (let index = 0; index < await tiles.count(); index += 1) {
      const key = await this.cardKey(tiles.nth(index))
      if (key) keys.push(key)
    }
    return keys
  }

  async watchNewCards(previousKeys: Set<string>, expected: number, onReady: (card: OutputCard) => void, timeoutMs = 12 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const seen = new Set(previousKeys)
    let ready = 0
    while (Date.now() < deadline) {
      const tiles = this.page.locator(flowSelectors.resultTile)
      const count = await tiles.count()
      for (let index = 0; index < count && ready < expected; index += 1) {
        const locator = tiles.nth(index)
        const key = await this.cardKey(locator)
        if (!key || seen.has(key)) continue
        seen.add(key)
        onReady({ locator, index: ready })
        ready += 1
      }
      if (ready >= expected) return
      await this.page.waitForTimeout(1_500)
    }
    throw new Error(`Timed out waiting for ${expected} completed Flow output(s).`)
  }

  async downloadCard(card: OutputCard, settings: RunSettings, jobIndex: number, promptIndex: number): Promise<string> {
    await mkdir(settings.downloadDirectory, { recursive: true })
    const base = sanitize(`job-${String(jobIndex + 1).padStart(3, "0")}-prompt-${String(promptIndex + 1).padStart(3, "0")}-variant-${card.index + 1}`)
    if (settings.output === "image" && settings.quality === "original-1k") {
      return this.downloadOriginalImage(card.locator, settings.downloadDirectory, base)
    }
    return this.downloadFromNativeMenu(card.locator, settings, settings.downloadDirectory, base)
  }

  private async downloadOriginalImage(card: Locator, directory: string, base: string): Promise<string> {
    const image = card.locator('img[alt*="Tile displaying"]')
    await image.waitFor({ state: "visible", timeout: 30_000 })
    const source = await image.evaluate((element) => (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src)
    if (!source.startsWith("https://flow-content.google/")) throw new Error("Flow original image URL was not available on the completed result card.")
    const response = await this.context.request.get(source)
    if (!response.ok()) throw new Error(`Original image download failed with HTTP ${response.status()}.`)
    const type = response.headers()["content-type"] || "image/png"
    const extension = type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : "png"
    const destination = path.join(directory, `${base}.${extension}`)
    await writeFile(destination, await response.body())
    return destination
  }

  private async downloadFromNativeMenu(card: Locator, settings: RunSettings, directory: string, base: string): Promise<string> {
    await card.hover()
    await card.locator(flowSelectors.moreOptions).click()
    await this.page.getByRole("menuitem", { name: /Download/i }).click()

    let selected: RegExp | undefined
    for (const candidate of qualityFallbacks(settings.output, settings.quality)) {
      const option = this.page.getByRole("menuitem", { name: qualityMenuLabel[candidate] })
      if (await option.count() && await option.isEnabled()) { selected = qualityMenuLabel[candidate]; break }
    }
    if (!selected) throw new Error("None of the requested or fallback native Flow download qualities is available.")

    const downloadPromise = this.page.waitForEvent("download", { timeout: 60_000 })
    await this.page.getByRole("menuitem", { name: selected }).click()
    const download = await downloadPromise
    const suggested = download.suggestedFilename()
    const extension = path.extname(suggested) || (settings.output === "video" ? ".mp4" : ".png")
    const destination = path.join(directory, `${base}${extension}`)
    await download.saveAs(destination)
    return destination
  }
}
