import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const project = process.cwd()
const destination = path.join(project, "src-tauri", "resources", "automation")
const build = path.join(project, "dist-sidecar")
const playwright = path.join(project, "node_modules", "playwright-core")

await rm(destination, { recursive: true, force: true })
await mkdir(path.join(destination, "node_modules"), { recursive: true })
await cp(build, destination, { recursive: true })
await cp(playwright, path.join(destination, "node_modules", "playwright-core"), {
  recursive: true,
  filter: (source) => {
    const normalized = source.replaceAll("\\", "/")
    return !normalized.includes("/lib/vite/") && !normalized.includes("/lib/tools/") && !normalized.endsWith(".map")
  },
})
await writeFile(path.join(destination, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`)

console.log(`Prepared Chrome-only Playwright sidecar at ${path.relative(project, destination)}.`)
