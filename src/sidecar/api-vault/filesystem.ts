import { constants } from "node:fs"
import { access, mkdir, readdir, realpath, rename, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { parseDocument } from "./documents.js"

export type FileGrant = { root: string; operation: "read" | "write" }
export type ToolContext = { workspace: string; readGrants: FileGrant[]; writeGrants: FileGrant[]; allowWrite: boolean; allowOverwrite: boolean }

function contains(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === "" || (!value.startsWith("..") && !isAbsolute(value))
}

async function nearestExisting(pathValue: string): Promise<string> {
  let cursor = pathValue
  for (;;) {
    try { await access(cursor, constants.F_OK); return cursor } catch { /* keep walking */ }
    const parent = dirname(cursor)
    if (parent === cursor) return cursor
    cursor = parent
  }
}

async function canonicalForAuthorization(pathValue: string): Promise<string> {
  const existing = await nearestExisting(pathValue)
  const canonical = await realpath(existing).catch(() => resolve(existing))
  const suffix = relative(existing, pathValue)
  return resolve(canonical, suffix)
}

function explicitPaths(prompt: string): string[] {
  const found = new Set<string>()
  const candidates = [
    ...prompt.matchAll(/["'`](?<path>(?:[A-Za-z]:[\\/]|\/)[^"'`\r\n]+)["'`]/g),
    ...prompt.matchAll(/(?<path>[A-Za-z]:[\\/][^\s"'`]+)/g),
  ]
  for (const match of candidates) {
    const raw = match.groups?.path?.trim().replace(/[.,;:]+$/, "")
    if (raw && isAbsolute(raw)) found.add(resolve(raw))
  }
  return [...found]
}

export function createToolContext(installDirectory: string, prompt: string, assetPaths: string[]): ToolContext {
  const workspace = resolve(installDirectory, ".agents")
  const promptPaths = explicitPaths(prompt)
  const explicitWriteIntent = /\b(?:save|write|export|store|simpan|tulis|ekspor|create|buat)\b/i.test(prompt)
  const descriptiveWriteIntent = /\b(?:(?:save|write|export|store|simpan|tulis|ekspor).{0,40}(?:file|folder|directory|path|json|txt|markdown|hasil|output)|(?:create|buat).{0,30}(?:file|folder|directory|json|txt|markdown))\b/i.test(prompt)
  return {
    workspace,
    allowWrite: descriptiveWriteIntent || (promptPaths.length > 0 && explicitWriteIntent),
    allowOverwrite: /\b(?:overwrite|replace\s+(?:the\s+)?existing|timpa|ganti\s+file)\b/i.test(prompt),
    readGrants: [workspace, ...assetPaths.map((pathValue) => resolve(pathValue)), ...promptPaths].map((root) => ({ root, operation: "read" as const })),
    writeGrants: [workspace, ...promptPaths].map((root) => ({ root, operation: "write" as const })),
  }
}

export async function resolveToolPath(context: ToolContext, requested: string, operation: "read" | "write"): Promise<string> {
  if (operation === "write" && !context.allowWrite) throw new Error("Local runtime blocked write because the direct user prompt did not request saving a file.")
  const target = resolve(isAbsolute(requested) ? requested : join(context.workspace, requested || "."))
  const canonical = await canonicalForAuthorization(target)
  const grants = operation === "read" ? context.readGrants : context.writeGrants
  for (const grant of grants) {
    const grantCanonical = await canonicalForAuthorization(resolve(grant.root))
    const grantStat = await stat(grant.root).catch(() => null)
    const grantsChildren = grant.root === context.workspace || grantStat?.isDirectory() === true
    if (grantsChildren ? contains(grantCanonical, canonical) : canonical === grantCanonical) return target
  }
  throw new Error(`Local runtime blocked ${operation} outside the authorized paths: ${requested}`)
}

async function availablePath(target: string, overwrite: boolean): Promise<string> {
  if (overwrite) return target
  try { await access(target) } catch { return target }
  const folder = dirname(target)
  const name = basename(target)
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ""
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = join(folder, `${stem}-${index}${extension}`)
    try { await access(candidate) } catch { return candidate }
  }
  throw new Error("Unable to choose an available output filename.")
}

export async function executeFilesystemTool(context: ToolContext, name: string, args: Record<string, unknown>): Promise<{ content: string; file?: string }> {
  const requested = typeof args.path === "string" ? args.path : "."
  if (name === "list_directory") {
    const target = await resolveToolPath(context, requested, "read")
    const entries = await readdir(target, { withFileTypes: true })
    return { content: JSON.stringify(entries.slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }))) }
  }
  if (name === "create_directory") {
    const target = await resolveToolPath(context, requested, "write")
    await mkdir(target, { recursive: true })
    return { content: JSON.stringify({ created: target }), file: target }
  }
  if (name === "get_file_metadata") {
    const target = await resolveToolPath(context, requested, "read")
    const metadata = await stat(target)
    return { content: JSON.stringify({ path: target, type: metadata.isDirectory() ? "directory" : "file", bytes: metadata.size, modified: metadata.mtime.toISOString() }) }
  }
  if (name === "read_file") {
    const target = await resolveToolPath(context, requested, "read")
    return { content: await parseDocument(target) }
  }
  if (name === "write_text_file" || name === "write_json_file") {
    const target = await resolveToolPath(context, requested, "write")
    const overwrite = args.overwrite === true
    if (overwrite && !context.allowOverwrite) throw new Error("Local runtime blocked overwrite because the direct user prompt did not request it.")
    const destination = await availablePath(target, overwrite)
    let content: string
    if (name === "write_json_file") {
      const value = args.content
      content = JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2)
    } else {
      if (typeof args.content !== "string") throw new Error("write_text_file requires string content.")
      content = args.content
    }
    await mkdir(dirname(destination), { recursive: true })
    const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" })
    await rename(temporary, destination)
    return { content: JSON.stringify({ saved: destination, bytes: Buffer.byteLength(content) }), file: destination }
  }
  throw new Error(`Unknown filesystem tool: ${name}`)
}

export const FILESYSTEM_TOOLS = [
  { type: "function", function: { name: "list_directory", description: "List an authorized directory before choosing where to save files.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "create_directory", description: "Create an authorized directory recursively.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "Read and locally parse an authorized text, Markdown, JSON, CSV, PDF, or DOCX file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "get_file_metadata", description: "Inspect an authorized file or directory.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "write_text_file", description: "Write text to the agent workspace or an external destination explicitly named by the user.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" } }, required: ["path", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "write_json_file", description: "Write valid JSON to the agent workspace or an external destination explicitly named by the user.", parameters: { type: "object", properties: { path: { type: "string" }, content: {}, overwrite: { type: "boolean" } }, required: ["path", "content"], additionalProperties: false } } },
] as const
