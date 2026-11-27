import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { AGENT_PROBE_REGISTRATION_SCHEMA } from '../orchestrator/src/agent/agent-probe.ts'
import { readStrictCodexSchema } from '../orchestrator/src/contract/codex-schema.ts'
import { resolveReplyDialect } from '../orchestrator/src/contract/contract.ts'
import { ISSUE_DIAGNOSIS_SCHEMA } from '../orchestrator/src/issue/issue.ts'
import { JOBS } from '../orchestrator/src/jobs/jobs.ts'
import { judgeSchema } from '../orchestrator/src/session-losses/session-losses-adapter.ts'
import { startBoundedSync } from '../shared/bounded-process.ts'
import { inspectionGitEnv } from '../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

type DeclaredSchema = { name: string; schema: object } | { name: string; file: string }

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

function jobSchemas(): DeclaredSchema[] {
  const schemas = new Map<object, { names: string[]; schemaName: string }>()
  for (const job of Object.values(JOBS)) {
    const dialect = resolveReplyDialect(job)
    const known = schemas.get(dialect.schema)
    if (known) known.names.push(job.name)
    else schemas.set(dialect.schema, { names: [job.name], schemaName: dialect.schemaName })
  }
  return [...schemas].map(([schema, description]) => ({
    name: `jobs ${description.names.join(', ')} (${description.schemaName})`,
    schema,
  }))
}

function declaredSchemas(): DeclaredSchema[] {
  return [
    ...jobSchemas(),
    // Passed by hub/src/note-curator-orch.ts to the note-curator run.
    {
      name: 'note curator reply (hub/src/note-curator-reply.schema.json)',
      file: 'hub/src/note-curator-reply.schema.json',
    },
    // Written by orchestrator/src/issue/issue.ts for the diagnosis dispatch.
    { name: 'issue diagnosis (ISSUE_DIAGNOSIS_SCHEMA)', schema: ISSUE_DIAGNOSIS_SCHEMA },
    // Written by orchestrator/src/session-losses/session-losses-adapter.ts for the judge run.
    { name: 'session-losses judge (judgeSchema)', schema: judgeSchema },
    // Written by orchestrator/src/agent/agent-probe.ts for the registration probe.
    {
      name: 'agent-probe registration (AGENT_PROBE_REGISTRATION_SCHEMA)',
      schema: AGENT_PROBE_REGISTRATION_SCHEMA,
    },
    // CANON_SOURCE_SCHEMA is a fragment embedded in other schemas, not a run root.
  ]
}

function undeclaredSchemaLiterals(handListedFiles: Set<string>): string[] {
  const refusals: string[] = []
  for (const path of trackedProductionTypeScript()) {
    const text = readFileSync(resolve(ROOT, path), 'utf8')
    if (!text.includes('--schema')) continue
    const literals = stringLiterals(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))
    if (!literals.includes('--schema')) continue
    for (const literal of literals) {
      const lastSegment = literal.split('/').at(-1) ?? ''
      if (
        literal.endsWith('.schema.json') &&
        lastSegment.length > '.schema.json'.length &&
        !handListedFiles.has(literal)
      ) {
        refusals.push(
          `${path}: undeclared --schema file literal ${JSON.stringify(literal)}; declare it in the run schema strict guard`,
        )
      }
    }
  }
  return refusals
}

if (import.meta.main) {
  const started = performance.now()
  const schemas = declaredSchemas()
  if (schemas.length === 0) {
    console.error(
      'run schema strict check found no schema; restore the declared list before rerunning',
    )
    process.exit(1)
  }

  const handListedFiles = new Set(schemas.flatMap((entry) => ('file' in entry ? [entry.file] : [])))
  const refusals = undeclaredSchemaLiterals(handListedFiles)
  const scratch = mkdtempSync(join(tmpdir(), 'run-schema-strict-'))
  const builtSchemaPath = join(scratch, 'schema.json')
  try {
    for (const entry of schemas) {
      try {
        const schemaPath = 'file' in entry ? resolve(ROOT, entry.file) : builtSchemaPath
        if ('schema' in entry) writeFileSync(schemaPath, JSON.stringify(entry.schema))
        readStrictCodexSchema(schemaPath)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        refusals.push(`${entry.name}: ${message}`)
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  for (const refusal of refusals) console.error(refusal)
  if (refusals.length > 0) process.exit(1)
  console.log(
    `run schema strict check: ${schemas.length} schemas passed in ${(performance.now() - started).toFixed(1)}ms`,
  )
}
