import { readdir, stat } from "node:fs/promises"
import path from "node:path"

const directory = path.resolve("src-tauri", "target", "release", "bundle", "nsis")
const entries = await readdir(directory)
const installers = entries.filter((name) => name.endsWith("-setup.exe"))

if (installers.length !== 1) throw new Error(`Expected exactly one NSIS installer, found: ${installers.join(", ") || "none"}`)
const installerPath = path.join(directory, installers[0])
const installer = await stat(installerPath)
const maximumBytes = 50 * 1024 * 1024
const requireSignature = !process.argv.includes("--allow-unsigned")
if (installer.size >= maximumBytes) {
  throw new Error(`Installer is ${(installer.size / 1024 / 1024).toFixed(1)} MiB; release limit is below 50 MiB.`)
}

const signatures = entries.filter((name) => name === `${installers[0]}.sig`)
if (requireSignature && signatures.length !== 1) throw new Error(`Missing updater signature for ${installers[0]}.`)

console.log(`Installer verified: ${installers[0]} is ${(installer.size / 1024 / 1024).toFixed(1)} MiB${requireSignature ? " with updater signature" : ""}.`)
