import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import mammoth from "mammoth"
import pdf from "pdf-parse/lib/pdf-parse.js"

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

export async function parseDocument(filePath: string): Promise<string> {
  const bytes = await readFile(filePath)
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error(`Document exceeds ${MAX_DOCUMENT_BYTES / 1024 / 1024} MiB.`)
  const extension = extname(filePath).toLowerCase()
  if ([".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".xml", ".html", ".css", ".js", ".ts"].includes(extension)) {
    return bytes.toString("utf8")
  }
  if (extension === ".pdf") return (await pdf(bytes)).text
  if (extension === ".docx") return (await mammoth.extractRawText({ buffer: bytes })).value
  throw new Error(`Unsupported document format: ${extension || "unknown"}`)
}
