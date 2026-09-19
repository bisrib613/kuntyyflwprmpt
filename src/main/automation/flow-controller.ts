import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core"
import type { AssetInput, PromptJob, RunSettings } from "../../shared/contracts.js"
import { qualityFallbacks, qualityMenuLabel } from "../../shared/quality.js"
import { FLOW_APP_URL, isSignedOutFlowRoute } from "./flow-route.js"
import { flowSelectors } from "./selectors.js"
import { logAutomation } from "../../sidecar/logger.js"

type OutputCard = { locator: Locator; index: number }
type ActiveProject = { id: string; name: string }

const sanitize = (value: string) => value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").slice(0, 120) || "output"
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export class FlowController {
  private readonly assetRefs = new Map<string, string>()
  private activeProjectId: string | null = null
  private constructor(private readonly browser: Browser, private readonly context: BrowserContext, private readonly page: Page) {}

  static async connect(cdpEndpoint: string): Promise<FlowController> {
    logAutomation("flowpilot.cdp.connect.start")
    const deadline = Date.now() + 20_000
    let browser: Browser | null = null
    let lastError: unknown
    while (!browser && Date.now() < deadline) {
      try {
        browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 2_000 })
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (!browser) {
      throw new Error(`FlowPilot's WebView2 automation endpoint did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
    }
    const context = browser.contexts()[0]
    if (!context) {
      await browser.close()
      throw new Error("FlowPilot opened its session, but WebView2 did not expose a browser context.")
    }
    context.setDefaultTimeout(30_000)
    const pages = context.pages()
    const page = pages.find((candidate) => /(^|\.)((labs|flow)\.google)$/.test(new URL(candidate.url()).hostname))
      || pages.find((candidate) => candidate.url() !== "about:blank")
      || await context.newPage()
    logAutomation("flowpilot.cdp.connect.complete", { pageCount: pages.length })
    return new FlowController(browser, context, page)
  }

  async close(): Promise<void> { await this.browser.close() }

  private async openFlowHome(): Promise<void> {
    logAutomation("flow.navigation.start", { destination: "app", url: FLOW_APP_URL })
    await this.page.goto(FLOW_APP_URL, { waitUntil: "domcontentloaded" })
    await this.page.waitForTimeout(1_000)
    const current = new URL(this.page.url())
    logAutomation("flow.navigation.complete", { destination: "app", hostname: current.hostname, pathname: current.pathname })
    if (isSignedOutFlowRoute(current.href)) {
      throw new Error("The selected FlowPilot session is signed out. Open this account in FlowPilot and sign in first.")
    }
  }

  private useProject(id: string): void {
    if (this.activeProjectId !== id) this.assetRefs.clear()
    this.activeProjectId = id
  }

  async openProject(settings: RunSettings): Promise<ActiveProject> {
    await this.openFlowHome()
    if (settings.projectMode === "new") {
      logAutomation("project.create.start")
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
      logAutomation("project.create.complete", { projectId: id })
      return { id, name: name || "New project" }
    }

    const recent = this.page.locator(flowSelectors.recentProject).filter({ visible: true }).first()
    logAutomation("project.recent.wait")
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
    logAutomation("project.recent.opened", { projectId: id })
    return { id, name: name || "Recent project" }
  }

  async configure(settings: RunSettings): Promise<void> {
    logAutomation("flow.configure.start", { output: settings.output, model: settings.model, aspectRatio: settings.aspectRatio, videoDuration: settings.output === "video" ? settings.videoDuration : undefined, variants: settings.variants })
    const settingsTrigger = this.page.locator(flowSelectors.settings)
    await settingsTrigger.click()

    const settingsOverlay = this.page.locator(flowSelectors.settingsOverlay)
      .filter({ has: this.page.getByLabel("Select model family") })
      .last()
    await settingsOverlay.waitFor({ state: "visible" })

    await this.selectRadio(settingsOverlay.getByRole("radio", { name: settings.output === "image" ? /Image/i : /Video/i }))
    await this.selectRadio(settingsOverlay.getByRole("radio", { name: new RegExp(settings.aspectRatio.replace(":", "\\s*:\\s*")) }))
    const modelTrigger = settingsOverlay.getByLabel("Select model family")
    if (await modelTrigger.isVisible() && !(await modelTrigger.innerText()).includes(settings.model)) {
      await modelTrigger.click()
      const modelMenu = this.page.getByRole("menu").last()
      await modelMenu.waitFor({ state: "visible" })
      await modelMenu.getByRole("menuitem", { name: new RegExp(`${escapeRegExp(settings.model)}$`) }).click()
      await this.page.locator(flowSelectors.settingsBackdrop).waitFor({ state: "hidden" })
    }
    if (settings.output === "video") {
      const duration = settingsOverlay.getByRole("radio", { name: new RegExp(`^${settings.videoDuration}\\s*(?:s|sec(?:ond)?s?)\\b`, "i") })
      if (!await duration.count()) throw new Error(`Google Flow did not expose the ${settings.videoDuration}s video duration for ${settings.model}.`)
      await this.selectRadio(duration)
    }
    await this.selectRadio(settingsOverlay.getByRole("radio", { name: `x${settings.variants}`, exact: true }))
    await this.page.keyboard.press("Escape")
    await settingsOverlay.waitFor({ state: "hidden" })
    logAutomation("flow.configure.complete")
  }

  private async selectRadio(radio: Locator): Promise<void> {
    await radio.waitFor({ state: "visible" })
    if ((await radio.getAttribute("aria-checked")) !== "true") await radio.click()
  }

  private assetPickerTrigger(): Locator {
    return this.page.locator(flowSelectors.assetPicker).last()
  }

  private async waitForAssetPickerState(expanded: boolean, timeoutMs = 5_000): Promise<void> {
    const trigger = this.assetPickerTrigger()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const isExpanded = (await trigger.getAttribute("aria-expanded")) === "true"
      if (isExpanded === expanded) return
      await this.page.waitForTimeout(100)
    }
    throw new Error(`Google Flow asset picker did not ${expanded ? "open" : "close"}.`)
  }

  private async openAssetPicker(): Promise<void> {
    const trigger = this.assetPickerTrigger()
    await trigger.waitFor({ state: "visible" })
    if ((await trigger.getAttribute("aria-expanded")) === "true") return
    const staleBackdrop = this.page.locator(flowSelectors.assetPickerBackdrop).last()
    if (await staleBackdrop.isVisible()) {
      await this.page.keyboard.press("Escape")
      await staleBackdrop.waitFor({ state: "hidden", timeout: 5_000 })
    }
    await trigger.click()
    await this.waitForAssetPickerState(true)
  }

  private async closeAssetPicker(): Promise<void> {
    const trigger = this.assetPickerTrigger()
    if ((await trigger.getAttribute("aria-expanded")) !== "true") return
    await this.page.keyboard.press("Escape")
    try {
      await this.waitForAssetPickerState(false)
    } catch {
      const backdrop = this.page.locator(flowSelectors.assetPickerBackdrop).last()
      if (await backdrop.isVisible()) await backdrop.click({ position: { x: 1, y: 1 } })
      await this.waitForAssetPickerState(false)
    }
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
    await this.openAssetPicker()
    try {
      for (const asset of missing) {
        const identity = await this.uploadOneAsset(asset)
        this.assetRefs.set(asset.id, identity)
      }
    } finally {
      await this.closeAssetPicker()
    }
  }

  private async attachAssets(assets: AssetInput[]): Promise<void> {
    await this.openAssetPicker()
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
    await this.waitForAssetPickerState(false)
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
