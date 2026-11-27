import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { readStrictCodexSchema } from '../orchestrator/src/contract/codex-schema.ts'
import { startBoundedSync } from '../shared/bounded-process.ts'
import { inspectionGitEnv } from '../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function trackedProductionTypeScript(): string[] {
  const result = startBoundedSync(['git', ...nulPathListArgs(['ls-files', '--', '*.ts'])], {
    budget: 'git-plumbing',
    cwd: ROOT,
    env: inspectionGitEnv(),
  })
  if (result.exitCode !== 0) {
    throw new Error(
      'git ls-files could not list tracked TypeScript files; restore Git access and rerun bun scripts/check-run-schemas-strict.ts',
    )
  }
  return splitNulPaths(result.stdout.toString()).filter(
    (path) => !path.endsWith('.test.ts') && !path.includes('/test/'),
  )
}

function stringLiterals(source: ts.SourceFile): string[] {
  const values: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) values.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}

function runSchemaPaths(): string[] {
  const schemas = new Set<string>()
  for (const path of trackedProductionTypeScript()) {
    const text = readFileSync(resolve(ROOT, path), 'utf8')
    const literals = stringLiterals(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))
    if (!literals.includes('--schema')) continue
    for (const literal of literals) {
      if (literal.endsWith('.schema.json')) schemas.add(resolve(ROOT, literal))
    }
  }
  return [...schemas].sort()
}

if (import.meta.main) {
  const started = performance.now()
  const schemas = runSchemaPaths()
  if (schemas.length === 0) {
    console.error(
      'run schema strict check found no schema; restore schema discovery before rerunning',
    )
    process.exit(1)
  }
  const refusals: string[] = []
  for (const schema of schemas) {
    try {
      readStrictCodexSchema(schema)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      refusals.push(`${relative(ROOT, schema)}: ${message}`)
    }
  }
  for (const refusal of refusals) console.error(refusal)
  if (refusals.length > 0) process.exit(1)
  console.log(
    `run schema strict check: ${schemas.length} schema${schemas.length === 1 ? '' : 's'} passed in ${(performance.now() - started).toFixed(1)}ms`,
  )
}
