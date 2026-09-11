import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { importSpecifiers } from './import-scanner.ts'

const root = new URL('..', import.meta.url).pathname
const rules = [
  { file: 'jobs.ts', forbidden: ['./agents.ts'] },
  { file: 'route.ts', forbidden: ['./review.ts'] },
  { file: 'review.ts', forbidden: ['./route.ts'] },
  { file: 'transport.ts', forbidden: ['./agents.ts', './transport-cli.ts', './transport-acp.ts'] },
]
const violations: string[] = []

for (const rule of rules) {
  const scan = importSpecifiers(readFileSync(join(root, 'orchestrator', 'src', rule.file), 'utf8'))
  const imports = new Set([...scan.specifiers, ...scan.typeOnlySpecifiers])
  for (const forbidden of rule.forbidden) {
    if (imports.has(forbidden)) violations.push(`${rule.file} must not import ${forbidden}`)
  }
}

if (violations.length) {
  console.error(`check-inversion-boundaries: ${violations.length} violation(s)\n${violations.join('\n')}`)
  process.exit(1)
}
console.log('check-inversion-boundaries: ok')
