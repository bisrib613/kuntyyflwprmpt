type MarkerPair = { open: string; close: string[] }

function markerPairsForModel(model: string): MarkerPair[] {
  const normalized = model.toLowerCase()
  const pairs: MarkerPair[] = []

  if (/kimi/.test(normalized)) {
    pairs.push({ open: "<|tool_calls_section_begin|>", close: ["<|tool_calls_section_end|>"] })
  }
  if (/deepseek|dsml/.test(normalized)) {
    pairs.push({
      open: "<｜DSML｜tool_calls>",
      close: ["</｜DSML｜tool_calls>", "</|DSML|tool_calls>", "<｜DSML｜tool_calls_end｜>"],
    })
    pairs.push({
      open: "<|DSML|tool_calls>",
      close: ["</|DSML|tool_calls>", "</｜DSML｜tool_calls>", "<|DSML|tool_calls_end|>"],
    })
  }
  if (/qwen/.test(normalized)) {
    pairs.push({ open: "<tool_call>", close: ["</tool_call>"] })
  }
  if (/kimi|deepseek|dsml|qwen|gemini|gemma|thinking|reason/.test(normalized)) {
    pairs.push({ open: "<think>", close: ["</think>"] })
    pairs.push({ open: "<thinking>", close: ["</thinking>"] })
    pairs.push({ open: "<|thinking|>", close: ["<|/thinking|>", "</|thinking|>"] })
    pairs.push({ open: "\u0060\u0060\u0060thinking\\n", close: ["\\n\u0060\u0060\u0060"] })
  }
  return pairs
}

/**
 * Stateful, model-targeted removal of known leaked protocol/reasoning envelopes.
 * It never infers tool execution from text: structured provider tool_calls remain
 * the runtime's only execution authority. Unknown model families are pass-through.
 */
export class VisibleTextNormalizer {
  private readonly pairs: MarkerPair[]
  private buffer = ""
  private suppressedBy: string[] | null = null

  constructor(model: string) {
    this.pairs = markerPairsForModel(model).sort((left, right) => right.open.length - left.open.length)
  }

  feed(chunk: string): string {
    if (!chunk) return ""
    this.buffer += chunk
    return this.consume(false)
  }

  flush(): string {
    const tail = this.consume(true)
    this.buffer = ""
    this.suppressedBy = null
    return tail
  }

  private consume(final: boolean): string {
    const input = this.buffer
    let index = 0
    let output = ""
    const allMarkers = this.pairs.flatMap((pair) => [pair.open, ...pair.close]).sort((a, b) => b.length - a.length)

    while (index < input.length) {
      if (this.suppressedBy) {
        let firstIndex = -1
        let firstMarker = ""
        for (const marker of this.suppressedBy) {
          const found = input.indexOf(marker, index)
          if (found >= 0 && (firstIndex < 0 || found < firstIndex || (found === firstIndex && marker.length > firstMarker.length))) {
            firstIndex = found
            firstMarker = marker
          }
        }
        if (firstIndex >= 0) {
          index = firstIndex + firstMarker.length
          this.suppressedBy = null
          continue
        }
        if (!final) {
          const hiddenTail = input.slice(index)
          const keep = longestMarkerPrefixSuffix(hiddenTail, this.suppressedBy)
          this.buffer = keep ? hiddenTail.slice(-keep) : ""
        } else {
          this.buffer = ""
        }
        return output
      }

      const opened = this.pairs.find((pair) => input.startsWith(pair.open, index))
      if (opened) {
        this.suppressedBy = opened.close
        index += opened.open.length
        continue
      }
      const strayClose = this.pairs.flatMap((pair) => pair.close).sort((a, b) => b.length - a.length)
        .find((marker) => input.startsWith(marker, index))
      if (strayClose) {
        index += strayClose.length
        continue
      }

      const remainder = input.slice(index)
      if (!final && allMarkers.some((marker) => remainder.length < marker.length && marker.startsWith(remainder))) {
        this.buffer = remainder
        return output
      }
      output += input[index]
      index += 1
    }

    this.buffer = ""
    return output
  }
}

function longestMarkerPrefixSuffix(text: string, markers: string[]): number {
  let longest = 0
  for (const marker of markers) {
    const max = Math.min(text.length, marker.length - 1)
    for (let size = max; size > longest; size -= 1) {
      if (text.endsWith(marker.slice(0, size))) {
        longest = size
        break
      }
    }
  }
  return longest
}

export function normalizeCompleteVisibleText(text: string, model: string): string {
  const normalizer = new VisibleTextNormalizer(model)
  return normalizer.feed(text) + normalizer.flush()
}
