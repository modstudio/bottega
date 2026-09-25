// concern: canon-edit-hook-ports
/** Supplies filesystem, state, and register facts to the canon edit hook handler. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  concernStateDirectory,
  resolveOrchestratorDatabase,
} from '../../../shared/state-directory.ts'
import type { EnforcedContext } from './canon-edit-guard.ts'
import type { CanonEditHookPorts } from './canon-edit-hook-handler.ts'
import type { TranscriptWatermark } from './canon-edit-transcript.ts'
import { canonFrontmatter } from './canon-lint.ts'

function transcriptLines(path: string): string[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function stateFile(session: string): string {
  const directory = join(concernStateDirectory('orchestrator', process.env), 'canon-edit-guard')
  return join(directory, `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

function readWatermark(session: string): TranscriptWatermark {
  try {
    const value = (JSON.parse(readFileSync(stateFile(session), 'utf8')) as { line?: unknown }).line
    if (value === 'unknown' || (typeof value === 'number' && Number.isInteger(value) && value >= 0))
      return value
    throw new Error('invalid watermark')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

function writeWatermark(session: string, line: TranscriptWatermark): void {
  const file = stateFile(session)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ line })}\n`)
}

function enforcedContexts(root: string): EnforcedContext[] {
  const directory = join(root, '.agents', 'contexts')
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .flatMap((entry) => {
      const metadata = canonFrontmatter(readFileSync(join(directory, entry.name), 'utf8'))
      return metadata?.enforce === true && metadata.paths.length > 0 && metadata.description
        ? [
            {
              path: `.agents/contexts/${entry.name}`,
              description: metadata.description,
              globs: metadata.paths,
            },
          ]
        : []
    })
}

export const canonEditHookPorts: CanonEditHookPorts = {
  readContexts: enforcedContexts,
  readTranscript: transcriptLines,
  readWatermark,
  writeWatermark,
  async readRegistered(cwd) {
    const [{ openReadOnlyDatabase }, { projectAt }] = await Promise.all([
      import('../database/db.ts'),
      import('../project/projects.ts'),
    ])
    const database = openReadOnlyDatabase(resolveOrchestratorDatabase(process.env))
    try {
      return projectAt(cwd, database)?.settings.managedContext === true
    } finally {
      database.close()
    }
  },
}
