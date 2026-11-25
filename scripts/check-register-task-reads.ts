#!/usr/bin/env bun
/**
 * File-level text heuristic for register-driven per-project task reads. It flags a file when a
 * per-project task read and either register selection or a default-project reference both occur.
 * Local reads of hosted tables are covered at runtime by the hosted-table guard.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const EXCLUDED_READER_DEFINITION = 'orchestrator/src/workflow/project-task-list.ts'
const REGISTER_TASK_READ_BASELINE = [
  'orchestrator/src/context-health/context-health-adapter.ts',
] as const
const REMEDY =
  "read a spaceless or default project's tasks from the local hub store (TaskReadPort.listLocal), or skip projects without a declared record space"

export type RegisterTaskReadFinding = { file: string; line: number }
type SourceFile = { file: string; text: string }

const perProjectTaskRead =
  /readProjectTaskList\s*\(|readLiveProjectTasks\s*\(|taskReader\(\)\.list\s*\(/
const registerProjectSelection =
  /projects\(\)\s*\.(?:filter|map|forEach)\s*\(|for\s*\([^)]*\bof\s+projects\(\)\s*\)/

/** Decide whether one production source combines a per-project task read with register selection. */
export function registerTaskReadFindings(file: string, text: string): RegisterTaskReadFinding[] {
  if (
    file.endsWith('.test.ts') ||
    file === EXCLUDED_READER_DEFINITION ||
    !perProjectTaskRead.test(text) ||
    (!registerProjectSelection.test(text) && !text.includes('DEFAULT_LOCAL_PROJECT_NAME'))
  )
    return []
  const match = perProjectTaskRead.exec(text)
  const line = match ? text.slice(0, match.index).split('\n').length : 1
  return [{ file, line }]
}

/** Apply the shrink-only baseline to already-read source text. */
export function registerTaskReadFailures(
  files: readonly SourceFile[],
  baseline: readonly string[] = REGISTER_TASK_READ_BASELINE,
): string[] {
  const findings = files.flatMap(({ file, text }) => registerTaskReadFindings(file, text))
  const matchingFiles = new Set(findings.map(({ file }) => file))
  return [
    ...findings
      .filter(({ file }) => !baseline.includes(file))
      .map(({ file, line }) => `${file}:${line}: ${REMEDY}`),
    ...baseline
      .filter((file) => !matchingFiles.has(file))
      .map(
        (file) =>
          `${file}: register-driven task-read baseline entry no longer matches; remove it from REGISTER_TASK_READ_BASELINE in scripts/check-register-task-reads.ts`,
      ),
  ]
}

function productionSources(): SourceFile[] {
  return ['orchestrator/src', 'cli', 'hub/src'].flatMap((directory) =>
    [...new Glob('**/*.ts').scanSync({ cwd: join(ROOT, directory) })]
      .filter((relative) => !relative.endsWith('.test.ts'))
      .map((relative) => {
        const file = `${directory}/${relative}`
        return { file, text: readFileSync(join(ROOT, file), 'utf8') }
      }),
  )
}

function run(): number {
  const failures = registerTaskReadFailures(productionSources())
  for (const failure of failures) console.error(failure)
  if (failures.length) return 1
  console.log('check-register-task-reads: ok')
  return 0
}

if (import.meta.main) process.exit(run())
