import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { staticCheckPlan } from './static-check-plan.ts'

export type UncheckedExitSource = { path: string; source: string }

export function uncheckedExitViolations(sources: readonly UncheckedExitSource[]): string[] {
  const forbidden = /process\.exit\(\s*0\s*\)/
  return sources.flatMap(({ path, source }) =>
    source
      .split('\n')
      .flatMap((line, index) =>
        forbidden.test(line)
          ? [
              `${path}:${index + 1}: process.exit(0) is refused in a gate check; let success fall through, or call exitUnchecked when the check could not run`,
            ]
          : [],
      ),
  )
}

function invokedScripts(): string[] {
  return [
    ...new Set(
      staticCheckPlan().flatMap((check) =>
        check
          .argv({ root: '', qualityBase: '--base=HEAD' })
          .filter((argument) => argument.endsWith('.ts')),
      ),
    ),
  ].sort()
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const violations = uncheckedExitViolations(
    invokedScripts().map((path) => ({ path, source: readFileSync(`${root}${path}`, 'utf8') })),
  )
  if (violations.length) {
    console.error(violations.join('\n'))
    process.exit(1)
  }
  console.log('unchecked exits: ok')
}
