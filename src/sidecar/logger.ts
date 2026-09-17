import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import path from "node:path"

const logDirIndex = process.argv.indexOf("--log-dir")
const configuredLogDirectory = logDirIndex >= 0 ? process.argv[logDirIndex + 1] : ""
export const logDirectory = configuredLogDirectory || path.join(process.cwd(), "logs")
const automationLog = path.join(logDirectory, "automation.log")
const crashLog = path.join(logDirectory, "crash.log")
const maxLogBytes = 2 * 1024 * 1024

function prepare(file: string): void {
  mkdirSync(logDirectory, { recursive: true })
  try {
    if (statSync(file).size < maxLogBytes) return
    try { unlinkSync(`${file}.previous`) } catch { /* No previous rotation yet. */ }
    renameSync(file, `${file}.previous`)
  } catch {
    // A missing log file is the normal first-run state.
  }
}

function serialize(details: Record<string, unknown>): string {
  return Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""
}

function append(file: string, event: string, details: Record<string, unknown>): void {
  try {
    prepare(file)
    appendFileSync(file, `[${new Date().toISOString()}] ${event}${serialize(details)}\n`, "utf8")
  } catch {
    // Diagnostics must never take down the automation runtime.
  }
}

export function logAutomation(event: string, details: Record<string, unknown> = {}): void {
  append(automationLog, event, details)
}

export function logCrash(event: string, error: unknown): void {
  const value = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  append(crashLog, event, value)
}
