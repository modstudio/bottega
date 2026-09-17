// concern: retrieval-keyword
/** Ranks the shared chunk corpus from literal query-term matches returned by ripgrep. */
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
  data: { path: { text: string }; lines: { text: string }; line_number: number }
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

function containingChunks(chunksByPath: Map<string, Chunk[]>, path: string, line: number): Chunk[] {
  return (chunksByPath.get(path) ?? []).filter(
    (chunk) => chunk.startLine <= line && chunk.endLine >= line,
  )
}

export async function keywordRanking(
  repositoryRoot: string,
  query: string,
  chunks: Chunk[],
): Promise<Chunk[]> {
  const terms = termsFor(query)
  const chunksByPath = new Map<string, Chunk[]>()
  for (const chunk of chunks) {
    const current = chunksByPath.get(chunk.path) ?? []
    current.push(chunk)
    chunksByPath.set(chunk.path, current)
  }
  const scores = new Map<string, Set<string>>()
  if (terms.length) {
    const child = Bun.spawn(
      [
        'rg',
        '--json',
        '--ignore-case',
        '--glob',
        '*.ts',
        '--glob',
        '*.md',
        '--regexp',
        terms.join('|'),
        'orchestrator/src',
        'hub/src',
        'shared',
        'scripts',
        '.agents',
      ],
      { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' },
    )
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
      const lower = event.data.lines.text.toLowerCase()
      const matched = terms.filter((term) => lower.includes(term))
      for (const chunk of containingChunks(
        chunksByPath,
        event.data.path.text,
        event.data.line_number,
      )) {
        const current = scores.get(chunk.id) ?? new Set<string>()
        for (const term of matched) current.add(term)
        scores.set(chunk.id, current)
      }
    }
  }
  return [...chunks].sort((left, right) => {
    const difference = (scores.get(right.id)?.size ?? 0) - (scores.get(left.id)?.size ?? 0)
    return difference || left.id.localeCompare(right.id)
  })
}
