import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = ['shared', 'orchestrator', 'scripts'] as const
const checkout = process.argv[2] ?? process.cwd()
const EXCLUDED = new Set(['shared/secret-shaped.ts', 'scripts/check-secret-shaped-redaction.ts'])
const WITHHELD_LITERAL = /(['"`])[^\n]*?(?:\[withheld|detail withheld|output withheld)[^\n]*?\1/
const FIXED_REPLACEMENT =
  /(?:if\s*\(\s*(?:containsSecretShaped|secretShapedRule)\([^)]*\)\s*\)\s*return\s*(?:['"`]|[A-Za-z_$][\w$]*(?![\w$.]|\s*\())|(?:containsSecretShaped|secretShapedRule)\([^)]*\)\s*\?\s*(?:['"`]|[A-Za-z_$][\w$]*(?![\w$.]|\s*\()))/

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

const failures: string[] = []
for (const root of ROOTS) {
  for (const path of sourceFiles(join(checkout, root))) {
    const local = relative(checkout, path)
    if (EXCLUDED.has(local)) continue
    const source = readFileSync(path, 'utf8')
    if (WITHHELD_LITERAL.test(source)) failures.push(`${local}: defines a withheld-text literal`)
    if (FIXED_REPLACEMENT.test(source))
      failures.push(`${local}: returns a fixed replacement from secret-shaped detection`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
