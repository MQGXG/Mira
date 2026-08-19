/** Levenshtein 距离 */
function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length)
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export function* simpleReplacer(_content: string, find: string): Generator<string> {
  yield find
}

export function* lineTrimmedReplacer(content: string, find: string): Generator<string> {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) { matches = false; break }
    }
    if (matches) {
      let start = 0
      for (let k = 0; k < i; k++) start += originalLines[k].length + 1
      let end = start
      for (let k = 0; k < searchLines.length; k++) {
        end += originalLines[i + k].length
        if (k < searchLines.length - 1) end += 1
      }
      yield content.substring(start, end)
    }
  }
}

export function* blockAnchorReplacer(content: string, find: string): Generator<string> {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines.length < 3) return
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()

  const firstLine = searchLines[0].trim()
  const lastLine = searchLines[searchLines.length - 1].trim()
  const blockSize = searchLines.length
  const maxDelta = Math.max(1, Math.floor(blockSize * 0.25))

  const candidates: Array<{ start: number; end: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLine) continue
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLine) {
        if (Math.abs((j - i + 1) - blockSize) <= maxDelta) candidates.push({ start: i, end: j })
        break
      }
    }
  }

  if (candidates.length === 0) return

  let best = candidates[0]
  let bestScore = 0

  for (const c of candidates) {
    let score = 0
    const mid = Math.min(searchLines.length - 2, (c.end - c.start + 1) - 2)
    if (mid > 0) {
      for (let j = 1; j <= mid; j++) {
        const maxLen = Math.max(originalLines[c.start + j].trim().length, searchLines[j].trim().length)
        if (maxLen > 0) score += 1 - levenshtein(originalLines[c.start + j].trim(), searchLines[j].trim()) / maxLen
      }
      score /= mid
    } else score = 1.0
    if (score > bestScore) { bestScore = score; best = c }
  }

  if (bestScore >= 0.65) {
    let start = 0
    for (let k = 0; k < best.start; k++) start += originalLines[k].length + 1
    let end = start
    for (let k = best.start; k <= best.end; k++) {
      end += originalLines[k].length
      if (k < best.end) end += 1
    }
    yield content.substring(start, end)
  }
}

export function* whitespaceReplacer(content: string, find: string): Generator<string> {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim()
  const normalizedFind = normalize(find)
  const lines = content.split("\n")
  for (const line of lines) {
    if (normalize(line) === normalizedFind) yield line
  }
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      if (normalize(lines.slice(i, i + findLines.length).join("\n")) === normalizedFind) {
        yield lines.slice(i, i + findLines.length).join("\n")
      }
    }
  }
}

export function* indentReplacer(content: string, find: string): Generator<string> {
  const removeIndent = (text: string) => {
    const lines = text.split("\n")
    const nonEmpty = lines.filter((l) => l.trim().length > 0)
    if (nonEmpty.length === 0) return text
    const min = Math.min(...nonEmpty.map((l) => (l.match(/^(\s*)/)?.[1]?.length || 0)))
    return lines.map((l) => l.trim().length === 0 ? l : l.slice(min)).join("\n")
  }
  const normalizedFind = removeIndent(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    if (removeIndent(contentLines.slice(i, i + findLines.length).join("\n")) === normalizedFind) {
      yield contentLines.slice(i, i + findLines.length).join("\n")
    }
  }
}

export function* escapeReplacer(content: string, find: string): Generator<string> {
  const unescape = (s: string) => s.replace(/\\(n|t|r|'|"|`|\\)/g, (_, c: string) => {
    switch (c) {
      case "n": return "\n"; case "t": return "\t"; case "r": return "\r"
      case "'": return "'"; case '"': return '"'; case "`": return "`"
      default: return c
    }
  })
  const unescaped = unescape(find)
  if (content.includes(unescaped)) yield unescaped
}

export function* trimmedBoundaryReplacer(content: string, find: string): Generator<string> {
  const trimmed = find.trim()
  if (trimmed === find) return
  if (content.includes(trimmed)) yield trimmed
}

export function* contextAwareReplacer(content: string, find: string): Generator<string> {
  const findLines = find.split("\n")
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === "") findLines.pop()
  const first = findLines[0].trim()
  const last = findLines[findLines.length - 1].trim()
  const contentLines = content.split("\n")
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== first) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() !== last) continue
      const block = contentLines.slice(i, j + 1)
      if (block.length !== findLines.length) continue
      let match = 0, total = 0
      for (let k = 1; k < block.length - 1; k++) {
        if (block[k].trim().length > 0 || findLines[k].trim().length > 0) {
          total++; if (block[k].trim() === findLines[k].trim()) match++
        }
      }
      if (total === 0 || match / total >= 0.5) { yield block.join("\n"); return }
      break
    }
  }
}

export function* multiOccurrenceReplacer(content: string, find: string): Generator<string> {
  let idx = 0
  while (true) {
    const pos = content.indexOf(find, idx)
    if (pos === -1) break
    yield find
    idx = pos + find.length
  }
}

export const REPLACERS = [
  simpleReplacer, lineTrimmedReplacer, blockAnchorReplacer,
  whitespaceReplacer, indentReplacer, escapeReplacer,
  trimmedBoundaryReplacer, contextAwareReplacer, multiOccurrenceReplacer,
]

export function isDisproportionate(match: string, find: string): boolean {
  const oldLines = find.split("\n").length
  const matchLines = match.split("\n").length
  if (matchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  return match.trim().length > Math.max(find.trim().length + 500, find.trim().length * 4)
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) throw new Error("oldString and newString are identical.")
  if (oldString === "") throw new Error("oldString must not be empty.")

  for (const replacer of REPLACERS) {
    for (const match of replacer(content, oldString)) {
      const index = content.indexOf(match)
      if (index === -1) continue
      if (isDisproportionate(match, oldString)) {
        throw new Error("Matched block is much larger than oldString. Re-read the file and provide more context.")
      }
      if (replaceAll) return content.replaceAll(match, newString)
      const last = content.lastIndexOf(match)
      if (index !== last) continue
      return content.substring(0, index) + newString + content.substring(index + match.length)
    }
  }

  throw new Error("Could not find oldString in the file. It must match exactly, including whitespace and indentation.")
}

export function limitDiffLines(diff: string, maxLines: number): string {
  const lines = diff.split("\n")
  if (lines.length <= maxLines) return diff
  const head = lines.slice(0, Math.ceil(maxLines / 2)).join("\n")
  const tail = lines.slice(lines.length - Math.floor(maxLines / 2)).join("\n")
  return `${head}\n... (${lines.length - maxLines} lines truncated, see \`git diff\` for full diff)\n${tail}`
}
