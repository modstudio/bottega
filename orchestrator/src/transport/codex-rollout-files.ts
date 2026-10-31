// concern: confined Codex rollout files
/** Locates rollout files below one Codex home and reads a turn-local slice. */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

export function confinedCodexRollouts(home: string | undefined): string[] {
  if (!home) return []
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return []
  try {
    const root = realpathSync(home)
    return [...new Bun.Glob('**/rollout-*.jsonl').scanSync({ cwd: sessions })]
      .sort()
      .flatMap((relative) => {
        const path = join(sessions, relative)
        const entry = lstatSync(path, { throwIfNoEntry: false })
        if (!entry?.isFile() || entry.isSymbolicLink()) return []
        const resolved = realpathSync(path)
        return resolved.startsWith(root + sep) ? [resolved] : []
      })
  } catch {
    return []
  }
}

export function codexRolloutTextsSince(
  home: string | undefined,
  offsets: Map<string, number>,
): { slice: string; full: string } {
  const slices: string[] = []
  const full: string[] = []
  for (const path of confinedCodexRollouts(home)) {
    try {
      const text = readFileSync(path, 'utf8')
      full.push(text)
      slices.push(text.slice(offsets.get(path) ?? 0))
    } catch {
      // Rollout observation is best-effort and never changes the run outcome.
    }
  }
  return { slice: slices.join('\n'), full: full.join('\n') }
}
