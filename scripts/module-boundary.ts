import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

export function checkModuleBoundary(
  check: string, file: string, allowed: readonly string[],
): void {
  const imports = importSpecifiers(readFileSync(`${ROOT}/${file}`, 'utf8'))
  const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers]
    .filter((specifier) => specifier.startsWith('.') && !allowed.includes(specifier))
    .map((specifier) => `${file} imports "${specifier}" outside its concern boundary`)
  violations.push(...imports.unresolvedRelative.map(
    (expression) => `${file} has an unresolved relative import at ${expression}`,
  ))
  if (violations.length) {
    console.error(`${check}: ${violations.length} violation(s)\n${violations.join('\n')}`)
    process.exit(1)
  }
  console.log(`${check}: ok`)
}
