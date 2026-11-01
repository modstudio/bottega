import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'

const ROOTS = ['shared', 'orchestrator', 'scripts', 'hub'] as const
const checkout = process.argv[2] ?? process.cwd()
const EXCLUDED = new Set(['shared/secret-shaped.ts', 'scripts/check-secret-shaped-redaction.ts'])
const PYTHON_RULE_OWNER = 'orchestrator/hooks/secret_shaped.py'
const WITHHELD_LITERAL = /(['"`])[^\n]*?(?:\[withheld|detail withheld|output withheld)[^\n]*?\1/
const FIXED_REPLACEMENT =
  /(?:if\s*\(\s*(?:containsSecretShaped|secretShapedRule)\([^)]*\)\s*\)\s*return\s*(?:['"`]|[A-Za-z_$][\w$]*(?![\w$.]|\s*\())|(?:containsSecretShaped|secretShapedRule)\([^)]*\)\s*\?\s*(?:['"`]|[A-Za-z_$][\w$]*(?![\w$.]|\s*\()))/
const PYTHON_SECRET_COMPILE =
  /re\.compile\(\s*(?:r|f|fr|rf)?(['"])(?:(?!\1)[\s\S])*?(?:Bearer|PRIVATE KEY|ghp_|Authorization)(?:(?!\1)[\s\S])*?\1/
const PYTHON_WHOLE_TEXT_WITHHOLD = 'withheld (secret-shaped)'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : []
  })
}

type PatternOwner = { name: string; pattern: string }

const table = JSON.parse(
  readFileSync(join(checkout, 'shared', 'secret-shaped-rules.json'), 'utf8'),
) as {
  rules: PatternOwner[]
  exemptEvidenceToken: { pattern: string }
}
const pythonPatternOwners = [
  ...table.rules,
  { name: 'exemptEvidenceToken', pattern: table.exemptEvidenceToken.pattern },
]

function copiedPythonPatterns(source: string): string[] {
  return pythonPatternOwners
    .filter(
      ({ pattern }) =>
        source.includes(pattern) || source.includes(pattern.replaceAll('\\', '\\\\')),
    )
    .map(({ name }) => name)
}

if (
  !copiedPythonPatterns(
    `fixture = r'${table.rules.find(({ name }) => name === 'base64')?.pattern}'`,
  ).includes('base64')
)
  throw new Error('secret-shaped guard self-check failed to refuse a copied base64 pattern')

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

const trackedPython = Bun.spawnSync([
  'git',
  '-C',
  checkout,
  ...nulPathListArgs(['ls-files', '--', '*.py']),
])
if (trackedPython.exitCode !== 0) {
  console.error('could not list tracked Python files; run this check from a Git checkout')
  process.exit(1)
}
for (const local of splitNulPaths(trackedPython.stdout.toString())) {
  const source = readFileSync(join(checkout, local), 'utf8')
  if (local !== PYTHON_RULE_OWNER && PYTHON_SECRET_COMPILE.test(source))
    failures.push(`${local}: compiles a secret-shaped pattern outside ${PYTHON_RULE_OWNER}`)
  if (local !== PYTHON_RULE_OWNER)
    for (const name of copiedPythonPatterns(source))
      failures.push(
        `${local}: copies the ${name} secret-shaped pattern outside ${PYTHON_RULE_OWNER}`,
      )
  if (source.includes(PYTHON_WHOLE_TEXT_WITHHOLD))
    failures.push(`${local}: defines a whole-text secret-shaped replacement`)
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
