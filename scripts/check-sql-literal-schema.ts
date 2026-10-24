import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import { applyMigrations as applyOrchestratorMigrations } from '../orchestrator/src/database/migrations.ts'
import { PROJECT_REFERENCES } from '../orchestrator/src/project/project-reference-counts.ts'

type ConcernName = 'orchestrator' | 'hub'
type Concern = { name: ConcernName; root: string; migrate(database: Database): unknown }
type SqlSite = { file: string; line: number; sql: string; interpolated: boolean }
type UnresolvedSite = { file: string; line: number; expression: string }
export type SqlExemption = { file: string; fingerprint: string; reason: string }
export type SqlCheckInput = {
  concerns: Concern[]
  exemptions?: readonly SqlExemption[]
  catalogues?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
}

const root = resolve(import.meta.dir, '..')
const SQL_START = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|PRAGMA|CREATE|DROP|ALTER)\b/i

export function sqlFingerprint(sql: string): string {
  return createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)
}

/** Content-addressed exceptions: moving a site is harmless; changing its SQL makes this stale. */
const exempt = (file: string, fingerprints: string[], reason: string): SqlExemption[] =>
  fingerprints.map((fingerprint) => ({ file, fingerprint, reason }))

const SQL_PREPARE_EXEMPTIONS: readonly SqlExemption[] = [
  ...exempt(
    'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    [
      '745f7343b84fd5a4',
      '331f8c8685d7d677',
      'ee5e68f062e9e167',
      '5df401ff49518044',
      '972f20f6287ebe94',
      '75474389eb0299f5',
      'c64f1af7766a43a8',
      'a0022d32d76a3074',
      '96978cbe844022ce',
      '6e102b06167918fe',
      '7af762ebaf9200dc',
      '9f2772d05cfc448f',
      'c18edc57e85d33c0',
      'dda95fa2a78be9c0',
      '5dd1d8a94ffb1e38',
      '299af31efbeb7ee4',
      'edf2eb08934e905d',
      '4ec7c53222c8a758',
    ],
    'workflow UUID migration preflight intentionally reads the legacy schema before 0153 rebuilds it',
  ),
  ...exempt(
    'orchestrator/src/database/migrations.ts',
    [
      'af1c320e825c0607',
      'f5ab4b5264982dab',
      '8af00ad0d221eb05',
      '124dce990db65f45',
      '3347c6a9e054fd21',
      '93f5fb6d946fcad0',
      '2847caa2831bb631',
    ],
    'schema introspection interpolates a quoted runtime identifier',
  ),
  ...exempt(
    'orchestrator/src/database/migrations.ts',
    ['0651cf428a37b47f', '4a0ead7d36fbbeb7'],
    'question migration orphan preflight reads controlled legacy table/column names before the UUID-key rebuild',
  ),
  ...exempt(
    'orchestrator/src/database/execution-uuid-migration-preflight.ts',
    ['faf93b9a220976e3'],
    'gate check migration orphan preflight reads controlled legacy columns before the UUID-key rebuild',
  ),
  ...exempt(
    'orchestrator/src/database/migrations.ts',
    [
      '8761a82c297b0919',
      'eafbbae5662e0614',
      '49517e4b901184a6',
      '1c0a8b50ea323b0f',
      '3867bb819315f03c',
    ],
    'document migration orphan preflight reads controlled legacy columns before the UUID-key rebuild',
  ),
  ...exempt(
    'orchestrator/src/database/migrations.ts',
    ['efa2cecd133ee061', '18b7c07f41bfcfaa', '61900e2060c08b91'],
    'review and landing migration orphan preflight reads controlled legacy table, column, and JSON references before the UUID-key rebuild',
  ),
  ...exempt(
    'orchestrator/src/database/migrations.ts',
    ['8df06207a3c2e335'],
    'board migration orphan preflight reads controlled legacy table and column references before the UUID-key rebuild',
  ),
  ...exempt(
    'orchestrator/src/database/execution-uuid-migration-preflight.ts',
    ['e0d77cabdacd8826'],
    'monitor migration orphan preflight reads controlled legacy columns before the UUID-key rebuild',
  ),
  ...exempt(
    'orchestrator/src/database/migrations.ts',
    ['4ec7c53222c8a758', 'a29c2123a01df1d0'],
    'migration runner executes SQL loaded from journal files',
  ),
  ...exempt(
    'orchestrator/src/database/lens-port-migration-preflight.ts',
    ['4ec7c53222c8a758'],
    'lens and port migration preflight executes a closed list of legacy-schema queries',
  ),
  ...exempt(
    'orchestrator/src/branch/branch-settlement.ts',
    ['d960c156a7b69340'],
    'query composes the shared chain-score join fragment',
  ),
  ...exempt(
    'orchestrator/src/record/landing-outbox.ts',
    ['1409ac1b2bba234b'],
    'backfill helper interpolates one of its two controlled table identifiers',
  ),
  ...exempt(
    'orchestrator/src/record/record-push-catalogues.ts',
    [
      '8cb8a' + 'b4259f57b' + 'a0',
      'c5add8a64972b365',
      'dab07398b13295e3',
      '4594af0a0333b22a',
      'fd6542b3e2b169cc',
    ],
    'workflow plan queries interpolate only the controlled workflow or step-catalogue table and foreign-key identifiers',
  ),
  ...exempt(
    'orchestrator/src/project/project-record-identity.ts',
    ['5f5a4fd2952d66ca'],
    'pre-0117 identity backfill runs only while the legacy project.id column exists',
  ),
  ...exempt(
    'orchestrator/src/project/project-rename.ts',
    ['84fd208db9cc3656', 'f64e0b4f7ec299e5', '4a165bfa9a300f39'],
    'rename service interpolates a reviewed project-name snapshot descriptor',
  ),
  ...exempt(
    'orchestrator/src/score/duel.ts',
    ['991f82c38cf5da83', '321c3dcef01b1308'],
    'duel query composes shared task and change identity SQL fragments',
  ),
  ...exempt(
    'orchestrator/src/cleanup/cleanup.ts',
    ['68fa42668d0605e9'],
    'cleanup query composes the shared chain-score join fragment',
  ),
  ...exempt(
    'orchestrator/src/cleanup/run-leftover-sweep.ts',
    ['b2a85af6f9488c27'],
    'run leftover query composes the shared evidence closure and chain-score join fragments',
  ),
  ...exempt(
    'orchestrator/src/review/review-triage.ts',
    ['fab77a172a06e251'],
    'triage query interpolates a runtime-sized lens predicate',
  ),
  ...exempt(
    'orchestrator/src/record/record-cache-workflow.ts',
    [
      '56b2a34b8ba485c3',
      '9fffbcd033474363',
      '359674a134693aa6',
      '87346bb51f6017fb',
      '764abad5e1b3bc85',
      '74222371f3041d5f',
      '50db7b6422dca830',
      'e2d69fa23fa2e682',
      '88afa6f95108216d',
      'd6c722546140eda9',
      '30c0302d2d1ef23d',
    ],
    'workflow cache reconciliation interpolates one controlled table and foreign-key descriptor',
  ),
  ...exempt(
    'hub/src/migrations.ts',
    ['c7d23902db0900b2'],
    'hub cursor migration setup writes its transaction-local identity map input table',
  ),
  ...exempt(
    'orchestrator/src/workflow/versioned-lifecycle.ts',
    [
      'b514371662c5bb23',
      'b526810e2ce81e6d',
      'b0943e751ef8942d',
      '4f1da1b7b9a1b66a',
      '05118990d99b1207',
      '5ebf145dbe0d5ad1',
      '3b6e0fc935c1c311',
      '342ba0a333bd0ef6',
      '37dcfc22b347e632',
      '0a2937477fb8a6d7',
      '9dd0da2c7f3911e5',
      'aa182a9273bdf629',
      '9d63a05b906a26f1',
      '34ee52e17532850c',
      '71f4aad86e05f33a',
      '4117180a80520023',
      '5ca1249106c1292d',
    ],
    'versioned lifecycle helper interpolates its controlled workflow table descriptor',
  ),
  ...exempt(
    'orchestrator/src/doc/doc-read-store.ts',
    [
      'f8888ced32de32c0',
      '05f81e19badd9e47',
      'e656228abf466e19',
      '8fe195c1c889a2e8',
      '4293f027793c01fe',
      'da08d7d0f2a56296',
      'e168fab9f7f4d16d',
    ],
    'document reader composes scope-dependent select and join clauses',
  ),
  ...exempt(
    'orchestrator/src/run/live-run-member.ts',
    ['f7d638579a50675d'],
    'live-member query composes the canonical current-member join',
  ),
  ...exempt(
    'orchestrator/src/reclaim/reclaim.ts',
    ['23389\u0062a364b4c75f'],
    'reclaim query composes the shared run-voiding expression',
  ),
  ...exempt(
    'orchestrator/src/record/record-sync.ts',
    ['a8b771920b8319e4'],
    'record sync executes a query selected by hosted record kind',
  ),
  ...exempt(
    'hub/src/hosted-change-cache.ts',
    ['e187eb7cea1d262e', 'ca6bd2b5e54e9d61'],
    'cache helper interpolates its controlled cache table identifier',
  ),
  ...exempt(
    'hub/src/task-cache.ts',
    [
      'b7f6c7605b1f9d32',
      '1f2d5abb47af88e2',
      'ca6bd2b5e54e9d61',
      'e187eb7cea1d262e',
      'f490ea925bd5b1f3',
    ],
    'task cache helper interpolates controlled table and column descriptors',
  ),
  ...exempt(
    'hub/src/migrations.ts',
    [
      'af1c320e825c0607',
      'f5ab4b5264982dab',
      '8af00ad0d221eb05',
      '124dce990db65f45',
      '3347c6a9e054fd21',
    ],
    'schema introspection interpolates a quoted runtime identifier',
  ),
  ...exempt(
    'hub/src/migrations.ts',
    ['4ec7c53222c8a758', 'a29c2123a01df1d0'],
    'migration runner executes SQL loaded from journal files',
  ),
  ...exempt(
    'hub/src/migrations.ts',
    ['b2041b8ea9401e3a', '01327b044ca67dd7', 'e769288de6fcaf17'],
    'question identity input is prepared against the legacy and migration-staging schemas',
  ),
  ...exempt(
    'hub/src/ingest/git-task-cache.ts',
    ['052a50d1f936d99a'],
    'transition helper runs only while migration task_new exists',
  ),
  ...exempt(
    'hub/src/ingest/trackers.ts',
    ['2987d7cb212ef65b'],
    'transition helper runs only while migration task_new exists',
  ),
  ...exempt(
    'hub/src/pending-hosted-edit.ts',
    ['f5e53a096b09bf92', '32d93769abfe79b5'],
    'hosted edit query composes its validated target descriptor',
  ),
  ...exempt(
    'hub/src/project-record-id.ts',
    ['bad37a0f763549ca'],
    'identity helper interpolates a validated project-bearing table name',
  ),
  ...exempt(
    'hub/src/fixture-question-reclaim.ts',
    ['bb95fd765e957183'],
    'transition helper runs only while migration task_new exists',
  ),
  ...exempt(
    'hub/src/task.ts',
    ['0dda1efcbf461147', '32b55c85ffad064b', '7760d25a5c81f210'],
    'transition helper runs only while migration task_new exists',
  ),
  ...exempt(
    'hub/src/task-identity.ts',
    ['4ec7c53222c8a758'],
    'task identity migration executes generated transition SQL',
  ),
]

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'postgres') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

function unwrap(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    return unwrap(node.expression)
  if (ts.isNonNullExpression(node)) return unwrap(node.expression)
  return node
}

function combinations(parts: string[][]): string[] {
  return parts.reduce<string[]>(
    (all, values) => all.flatMap((left) => values.map((right) => left + right)),
    [''],
  )
}

type ResolvedStrings = { values: string[]; interpolated: boolean }

function mergeExpressions(
  expressions: ts.Expression[],
  constants: Map<string, ts.Expression>,
  substitutions: Readonly<Record<string, readonly string[]>>,
  seen: Set<string>,
  concatenate: boolean,
): ResolvedStrings | null {
  const values = expressions.map((item) => expressionStrings(item, constants, substitutions, seen))
  if (values.some((value) => value === null)) return null
  const resolved = values as ResolvedStrings[]
  return {
    values: concatenate
      ? combinations(resolved.map((value) => value.values))
      : [...new Set(resolved.flatMap((value) => value.values))],
    interpolated: resolved.some((value) => value.interpolated),
  }
}

function templateStrings(
  node: ts.TemplateExpression,
  constants: Map<string, ts.Expression>,
  substitutions: Readonly<Record<string, readonly string[]>>,
  seen: Set<string>,
): ResolvedStrings {
  const parts: string[][] = [[node.head.text]]
  for (const span of node.templateSpans) {
    const value = expressionStrings(span.expression, constants, substitutions, seen)
    parts.push(value?.values ?? ['NULL'], [span.literal.text])
  }
  return { values: combinations(parts), interpolated: true }
}

function expressionStrings(
  expression: ts.Expression,
  constants: Map<string, ts.Expression>,
  substitutions: Readonly<Record<string, readonly string[]>>,
  seen = new Set<string>(),
): ResolvedStrings | null {
  const node = unwrap(expression)
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    return { values: [node.text], interpolated: false }
  if (ts.isIdentifier(node)) {
    const substituted = substitutions[node.text]
    if (substituted) return { values: [...substituted], interpolated: true }
    if (seen.has(node.text)) return null
    const initializer = constants.get(node.text)
    if (!initializer) return null
    return expressionStrings(initializer, constants, substitutions, new Set([...seen, node.text]))
  }
  if (ts.isConditionalExpression(node)) {
    return mergeExpressions([node.whenTrue, node.whenFalse], constants, substitutions, seen, false)
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return mergeExpressions([node.left, node.right], constants, substitutions, seen, true)
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { values: [node.text], interpolated: false }
  if (ts.isTemplateExpression(node)) return templateStrings(node, constants, substitutions, seen)
  return null
}

function sqlCallArgument(node: ts.Node): ts.Expression | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null
  if (!['query', 'prepare', 'exec'].includes(node.expression.name.text)) return null
  return node.arguments[0] ?? null
}

function addSqlArgument(input: {
  argument: ts.Expression
  source: ts.SourceFile
  fileName: string
  constants: Map<string, ts.Expression>
  substitutions: Readonly<Record<string, readonly string[]>>
  sites: SqlSite[]
  unresolved: UnresolvedSite[]
}): void {
  const { argument, source, fileName, constants, substitutions, sites, unresolved } = input
  const line = source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1
  const resolved = substitutions.$statements
    ? { values: [...substitutions.$statements], interpolated: true }
    : expressionStrings(argument, constants, substitutions)
  if (resolved) {
    for (const sql of resolved.values)
      if (SQL_START.test(sql))
        sites.push({ file: fileName, line, sql, interpolated: resolved.interpolated })
    return
  }
  const expression = argument.getText(source)
  const node = unwrap(argument)
  const namedSql =
    ts.isIdentifier(node) && /(?:sql|query|statement|executable|migration)/i.test(expression)
  if (namedSql || ts.isConditionalExpression(node) || ts.isTemplateExpression(node))
    unresolved.push({ file: fileName, line, expression })
}

function extractSqlSites(
  concern: Concern,
  catalogues: SqlCheckInput['catalogues'] = {},
): { sites: SqlSite[]; unresolved: UnresolvedSite[] } {
  const sites: SqlSite[] = []
  const unresolved: UnresolvedSite[] = []
  for (const file of productionTypeScriptFiles(concern.root)) {
    const fileName = relative(root, file)
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const constants = new Map<string, ts.Expression>()
    const collect = (node: ts.Node): void => {
      if (ts.isVariableStatement(node) && node.declarationList.flags & ts.NodeFlags.Const)
        for (const declaration of node.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.initializer)
            constants.set(declaration.name.text, declaration.initializer)
      ts.forEachChild(node, collect)
    }
    collect(source)
    const visit = (node: ts.Node): void => {
      const argument = sqlCallArgument(node)
      if (argument)
        addSqlArgument({
          argument,
          source,
          fileName,
          constants,
          substitutions: catalogues[fileName] ?? {},
          sites,
          unresolved,
        })
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { sites, unresolved }
}

function checkConcern(input: {
  concern: Concern
  catalogues: SqlCheckInput['catalogues']
  exemptionByKey: Map<string, SqlExemption>
  unused: Set<string>
  prepared: Record<ConcernName, number>
  skipped: Record<ConcernName, number>
  failures: string[]
}): void {
  const { concern, catalogues, exemptionByKey, unused, prepared, skipped, failures } = input
  const database = new Database(':memory:')
  try {
    concern.migrate(database)
    const extracted = extractSqlSites(concern, catalogues)
    const candidates = [
      ...extracted.sites.map((site) => ({ ...site, fingerprint: sqlFingerprint(site.sql) })),
      ...extracted.unresolved.map((site) => ({
        ...site,
        sql: site.expression,
        interpolated: false,
        fingerprint: sqlFingerprint(site.expression),
      })),
    ]
    for (const site of candidates) {
      const key = `${site.file}#${site.fingerprint}`
      if (exemptionByKey.has(key)) {
        unused.delete(key)
        skipped[concern.name] += 1
      } else if ('expression' in site) {
        failures.push(
          `${site.file}:${site.line} unresolved SQL argument ${site.expression} [${site.fingerprint}]`,
        )
      } else {
        try {
          database.prepare(site.sql)
          prepared[concern.name] += 1
        } catch (error) {
          failures.push(
            `${site.file}:${site.line}${site.interpolated ? ' (interpolated)' : ''}: ${(error as Error).message} [${site.fingerprint}]`,
          )
        }
      }
    }
  } finally {
    database.close()
  }
}

export function checkSqlLiteralSchemaWith(input: SqlCheckInput): {
  prepared: Record<ConcernName, number>
  skipped: Record<ConcernName, number>
  exemptions: SqlExemption[]
} {
  const prepared = { orchestrator: 0, hub: 0 }
  const skipped = { orchestrator: 0, hub: 0 }
  const failures: string[] = []
  const exemptions = input.exemptions ?? []
  const unused = new Set(exemptions.map(({ file, fingerprint }) => `${file}#${fingerprint}`))
  const exemptionByKey = new Map(
    exemptions.map((item) => [`${item.file}#${item.fingerprint}`, item]),
  )
  for (const concern of input.concerns)
    checkConcern({
      concern,
      catalogues: input.catalogues,
      exemptionByKey,
      unused,
      prepared,
      skipped,
      failures,
    })
  for (const key of unused) failures.push(`stale SQL exemption: ${key}`)
  if (failures.length)
    throw new Error(
      `SQL literals do not prepare against the current schema:\n${failures.join('\n')}`,
    )
  return { prepared, skipped, exemptions: [...exemptions] }
}

function checkSqlLiteralSchema() {
  const referenceStatements = PROJECT_REFERENCES.map(
    ([key, , column, explicitTable]) =>
      `SELECT COUNT(*) AS n FROM ${explicitTable ?? key} WHERE ${column}=?`,
  )
  return checkSqlLiteralSchemaWith({
    concerns: [
      {
        name: 'orchestrator',
        root: resolve(root, 'orchestrator/src'),
        migrate: applyOrchestratorMigrations,
      },
      {
        name: 'hub',
        root: resolve(root, 'hub/src'),
        migrate: (database) =>
          applyHubMigrations(database, undefined, {
            machine_id: '01990000-0000-7000-8000-000000000001',
          }),
      },
    ],
    exemptions: SQL_PREPARE_EXEMPTIONS,
    catalogues: {
      'orchestrator/src/project/project-reference-counts.ts': {
        $statements: referenceStatements,
      },
    },
  })
}

if (import.meta.main) {
  const result = checkSqlLiteralSchema()
  console.log(
    `SQL literal schema: prepared ${result.prepared.orchestrator} orchestrator and ${result.prepared.hub} hub statements; skipped ${result.skipped.orchestrator} orchestrator and ${result.skipped.hub} hub sites`,
  )
  for (const exemption of result.exemptions)
    console.log(`  exempt ${exemption.file}#${exemption.fingerprint}: ${exemption.reason}`)
}
