import { readdir, stat } from "node:fs/promises"
import path from "node:path"

const releaseDirectory = path.resolve("release")
const entries = await readdir(releaseDirectory)
const installers = entries.filter((name) => name.endsWith(".exe") && !name.toLowerCase().includes("uninstall"))

if (installers.length !== 1) throw new Error(`Expected exactly one installer, found: ${installers.join(", ") || "none"}`)
for (const required of ["latest.yml", `${installers[0]}.blockmap`]) {
  if (!entries.includes(required)) throw new Error(`Missing release artifact: ${required}`)
}

const installerPath = path.join(releaseDirectory, installers[0])
const installer = await stat(installerPath)
const maximumInstallerBytes = 100 * 1024 * 1024
if (installer.size >= maximumInstallerBytes) {
  throw new Error(`Installer is ${(installer.size / 1024 / 1024).toFixed(1)} MiB; release limit is below 100 MiB.`)
}

const unpackedDirectory = path.join(releaseDirectory, "win-unpacked")
const locales = (await readdir(path.join(unpackedDirectory, "locales"))).filter((name) => name.endsWith(".pak")).sort()
if (locales.join("\n") !== ["en-US.pak", "id.pak"].sort().join("\n")) {
  throw new Error(`Unexpected packaged locales: ${locales.join(", ")}`)
}

const asar = await stat(path.join(unpackedDirectory, "resources", "app.asar"))
if (asar.size >= 15 * 1024 * 1024) throw new Error(`app.asar is ${(asar.size / 1024 / 1024).toFixed(1)} MiB; expected below 15 MiB.`)

console.log(`Release verified: ${(installer.size / 1024 / 1024).toFixed(1)} MiB installer, ${(asar.size / 1024 / 1024).toFixed(1)} MiB app.asar, locales ${locales.join(", ")}.`)
