export function extractFencedCode(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const blocks: string[] = []
  let activeFence: { character: string; length: number; lines: string[] } | undefined

  for (const line of lines) {
    if (!activeFence) {
      const opening = /^[ \t]{0,3}((?:\u0060){3,}|~{3,})(.*)$/.exec(line)
      if (!opening) continue
      const marker = opening[1]
      const info = opening[2]
      if (marker[0] === "\u0060" && info.includes("\u0060")) continue
      activeFence = { character: marker[0], length: marker.length, lines: [] }
      continue
    }

    const fenceCharacter = activeFence.character === "\u0060" ? "\u0060" : "~"
    const closing = new RegExp("^[ \t]{0,3}" + fenceCharacter + "{" + activeFence.length + ",}[ \t]*$")
    if (closing.test(line)) {
      const code = activeFence.lines.join("\n")
      if (code.length) blocks.push(code)
      activeFence = undefined
    } else {
      activeFence.lines.push(line)
    }
  }

  if (activeFence) {
    const code = activeFence.lines.join("\n")
    if (code.length) blocks.push(code)
  }

  return blocks.join("\n\n")
}
