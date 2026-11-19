import { fileURLToPath } from 'node:url'
import { collectCanonLintInput } from '../src/canon/canon-files.ts'
import type { CanonFile } from '../src/canon/canon-lint.ts'
import { DEFAULT_PACK_BYTES } from '../src/canon/pack-budget.ts'
import { packedCanonMarkdownFromTree } from '../src/canon/pack-content.ts'
import { JOBS } from '../src/jobs/jobs.ts'

export type TreePackBudgetFailure = {
  job: string
  bytes: number
  ceiling: number
}

export function checkTreePackBudget(files: CanonFile[]): TreePackBudgetFailure[] {
  const bytes = Buffer.byteLength(packedCanonMarkdownFromTree(files).markdown)
  return Object.entries(JOBS).flatMap(([job, definition]) => {
    const ceiling = definition.packBytes ?? DEFAULT_PACK_BYTES
    return bytes > ceiling ? [{ job, bytes, ceiling }] : []
  })
}

function main(): void {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const failures = checkTreePackBudget(collectCanonLintInput(root).files)
  if (failures.length) {
    console.error(
      `tree canon pack budget failed for ${failures.length} job(s):\n${failures
        .map(({ job, bytes, ceiling }) => `${job}: ${bytes} bytes; ceiling ${ceiling} bytes`)
        .join('\n')}`,
    )
    process.exit(1)
  }
  console.log(`tree canon pack budget ok for ${Object.keys(JOBS).length} jobs`)
}

if (import.meta.main) main()
