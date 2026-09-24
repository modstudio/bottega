// concern: retrieval-keyword
/** Ranks the shared in-memory corpus from literal query-term matches returned by ripgrep. */
import type { Chunk } from '../corpus/chunks.ts'

const STOP_WORDS = new Set([
  'and',
  'are',
  'but',
  'for',
  'from',
  'has',
  'its',
  'not',
  'only',
  'than',
  'that',
  'the',
  'their',
  'this',
  'through',
  'with',
])

type RipgrepMatch = {
  type: 'match'
  data: { lines: { text: string }; line_number: number }
}

function isMatch(event: RipgrepMatch | { type: string }): event is RipgrepMatch {
  return event.type === 'match'
}

function termsFor(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.filter((term) => term.length >= 3 && !STOP_WORDS.has(term)) ?? [],
    ),
  ]
}

export async function keywordRanking(query: string, chunks: Chunk[]): Promise<Chunk[]> {
  const terms = termsFor(query)
  const scores = new Map<string, Set<string>>()
  if (terms.length) {
    const corpus = chunks.map((chunk) => chunk.text.replaceAll('\n', ' ')).join('\n')
    const child = Bun.spawn(['rg', '--json', '--ignore-case', '--regexp', terms.join('|'), '-'], {
      stdin: new Blob([corpus]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error(`ripgrep keyword baseline failed: ${stderr.trim() || `exit ${exitCode}`}`)
    }
    for (const line of stdout.split('\n')) {
      if (!line) continue
      const event = JSON.parse(line) as RipgrepMatch | { type: string }
      if (!isMatch(event)) continue
      const chunk = chunks[event.data.line_number - 1]
      if (!chunk) continue
      const lower = event.data.lines.text.toLowerCase()
      const matched = terms.filter((term) => lower.includes(term))
      const current = scores.get(chunk.id) ?? new Set<string>()
      for (const term of matched) current.add(term)
      scores.set(chunk.id, current)
    }
  }
  return [...chunks].sort((left, right) => {
    const difference = (scores.get(right.id)?.size ?? 0) - (scores.get(left.id)?.size ?? 0)
    return difference || left.id.localeCompare(right.id)
  })
}
