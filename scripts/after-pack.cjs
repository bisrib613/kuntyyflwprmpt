const { readdir, rm } = require("node:fs/promises")
const path = require("node:path")

const WINDOWS_LOCALES = new Set(["en-US.pak", "id.pak"])

module.exports = async function trimPackagedRuntime(context) {
  if (context.electronPlatformName !== "win32") return

  const localesDirectory = path.join(context.appOutDir, "locales")
  const entries = await readdir(localesDirectory, { withFileTypes: true })
  const removable = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".pak") && !WINDOWS_LOCALES.has(entry.name))

  await Promise.all(removable.map((entry) => rm(path.join(localesDirectory, entry.name), { force: true })))

  const remaining = (await readdir(localesDirectory)).filter((name) => name.endsWith(".pak")).sort()
  const expected = [...WINDOWS_LOCALES].sort()
  if (remaining.join("\n") !== expected.join("\n")) {
    throw new Error(`Unexpected Electron locales after trimming: ${remaining.join(", ")}`)
  }

  console.log(`Trimmed Electron locales: removed ${removable.length}, kept ${remaining.join(", ")}`)
}
