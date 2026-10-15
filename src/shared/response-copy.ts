export function extractFencedCode(text: string): string {
  const pattern = /^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)^[ \t]{0,3}\1[ \t]*(?=\r?$)/gm
  const blocks: string[] = []
  for (const match of text.matchAll(pattern)) {
    const code = match[2].replace(/\r\n/g, "\n").replace(/\n$/, "")
    if (code.length) blocks.push(code)
  }
  return blocks.join("\n\n")
}
