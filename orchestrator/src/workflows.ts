import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, writableDb, writeTransaction } from './db.ts'
import { type InjectionSource, resolveInjection } from './project-injection.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { type VersionEvent, versionedLifecycle } from './versioned-lifecycle.ts'

type WorkflowArgument = { name: string; required: boolean; description: string }
type WorkflowMode = {
  slug: string
  title: string
  default?: boolean
  entry?: string
  steps: string[]
}
export type WorkflowDefinition = {
  title: string
  description: string
  arguments: WorkflowArgument[]
  modes: WorkflowMode[]
  // Steps are shared on purpose: a catalogue change reaches every workflow
  // that uses the step. The catalogue is therefore versioned, and compose
  // reports the exact catalogue version alongside the workflow version.
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' ? value : '')

export function validateWorkflowDefinition(value: unknown, d?: Database): string[] {
  const errors: string[] = []
  if (!object(value)) return ['definition must be an object']
  if (typeof value.title !== 'string') errors.push('title must be a string')
  else if (!value.title.trim()) errors.push('title must be non-empty')
  if (typeof value.description !== 'string') errors.push('description must be a string')
  const args = Array.isArray(value.arguments) ? value.arguments : []
  const modes = Array.isArray(value.modes) ? value.modes : []
  if (!Array.isArray(value.arguments)) errors.push('arguments must be an array')
  if (!Array.isArray(value.modes)) errors.push('modes must be an array')
  if ('steps' in value) errors.push('steps belongs in the shared step catalogue')

  for (const [index, argument] of args.entries()) {
    if (!object(argument)) {
      errors.push(`argument ${index + 1} must be an object`)
      continue
    }
    if (typeof argument.name !== 'string')
      errors.push(`argument ${index + 1} name must be a string`)
    if (typeof argument.required !== 'boolean')
      errors.push(`argument "${text(argument.name)}" required must be a boolean`)
    if (typeof argument.description !== 'string')
      errors.push(`argument "${text(argument.name)}" description must be a string`)
  }
  for (const [index, mode] of modes.entries()) {
    if (!object(mode)) {
      errors.push(`mode ${index + 1} must be an object`)
      continue
    }
    if (typeof mode.slug !== 'string') errors.push(`mode ${index + 1} slug must be a string`)
    if (typeof mode.title !== 'string')
      errors.push(`mode "${text(mode.slug)}" title must be a string`)
    if (mode.default !== undefined && typeof mode.default !== 'boolean')
      errors.push(`mode "${text(mode.slug)}" default must be a boolean`)
    if (mode.entry !== undefined && typeof mode.entry !== 'string')
      errors.push(`mode "${text(mode.slug)}" entry must be a string`)
    if (!Array.isArray(mode.steps) || mode.steps.some((step) => typeof step !== 'string'))
      errors.push(`mode "${text(mode.slug)}" steps must be a string array`)
  }

  const checkSlugs = (items: unknown[], kind: string) => {
    const seen = new Set<string>()
    for (const item of items) {
      const slug = object(item) ? text(item.slug) : ''
      if (!SLUG.test(slug)) errors.push(`${kind} slug "${slug}" is not well-formed`)
      if (seen.has(slug)) errors.push(`duplicate ${kind} slug "${slug}"`)
      seen.add(slug)
    }
  }
  checkSlugs(
    args.map((arg) => (object(arg) ? { slug: arg.name } : arg)),
    'argument',
  )
  checkSlugs(modes, 'mode')

  const defaults = modes.filter((mode) => object(mode) && mode.default === true)
  if (defaults.length > 1) errors.push('exactly one default mode is allowed')
  if (defaults.length === 0) {
    for (const mode of modes) {
      if (!object(mode) || !text(mode.entry).trim()) {
        errors.push(
          `mode "${object(mode) ? text(mode.slug) : ''}" needs an entry question when there is no default`,
        )
      }
    }
  } else {
    for (const mode of modes) {
      if (object(mode) && text(mode.entry).trim()) {
        errors.push(
          `mode "${text(mode.slug)}" has an unreachable entry question beside a default mode`,
        )
      }
    }
  }

  let stepNames: Set<string> | null = null
  if (d)
    try {
      stepNames = new Set(productionStepCatalogue(d).definition.steps.map((step) => step.slug))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  for (const mode of modes) {
    if (!object(mode)) continue
    if (!Array.isArray(mode.steps) || mode.steps.length === 0) {
      errors.push(`mode "${text(mode.slug)}" must contain at least one step`)
      continue
    }
    for (const ref of mode.steps) {
      if (typeof ref !== 'string' || (stepNames !== null && !stepNames.has(ref)))
        errors.push(`mode "${text(mode.slug)}" references missing step "${String(ref)}"`)
    }
  }
  return [...new Set(errors)]
}

function requireValid(value: unknown, d: Database): asserts value is WorkflowDefinition {
  const errors = validateWorkflowDefinition(value, d)
  if (errors.length)
    throw new Error(`invalid workflow definition:\n${errors.map((e) => `- ${e}`).join('\n')}`)
}
function requireSlug(slug: string): void {
  if (!SLUG.test(slug))
    throw new Error(
      'invalid slug; use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit',
    )
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

type VersionRow = {
  id: number
  workflow_id: number
  slug: string
  n: number
  status: 'draft' | 'production' | 'retired'
  definition: string
  author: string
  reason: string
  created_at: string
  promoted_at: string | null
  retired_at: string | null
}
function versionRow(slug: string, n?: number, d: Database = db()): VersionRow {
  // Unqualified show prefers production, then the newest draft, then the
  // newest retired. A newer draft must not shadow live production.
  const where =
    n === undefined
      ? `ORDER BY CASE status WHEN 'production' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, n DESC LIMIT 1`
      : `AND v.n=?`
  const row = d
    .query(
      `SELECT v.*, w.slug FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? ${where}`,
    )
    .get(...(n === undefined ? [slug] : [slug, n])) as VersionRow | null
  if (!row)
    throw new Error(
      n === undefined ? `unknown workflow "${slug}"` : `workflow "${slug}" has no version ${n}`,
    )
  return row
}
const parseVersion = (row: VersionRow) => ({
  ...row,
  definition: JSON.parse(row.definition) as WorkflowDefinition,
})

function productionVersionRow(slug: string, d: Database = db()): VersionRow {
  const row = d
    .query(`SELECT v.*, w.slug FROM workflow_version v
    JOIN workflow w ON w.id=v.workflow_id
    WHERE w.slug=? AND v.status='production'`)
    .get(slug) as VersionRow | null
  if (!row) throw new Error(`workflow "${slug}" has no production version; promote one`)
  return row
}

export function listWorkflows(d: Database = db()) {
  const rows = d
    .query(`SELECT w.id,w.slug,
    (SELECT n FROM workflow_version WHERE workflow_id=w.id AND status='production') production_n,
    (SELECT MAX(n) FROM workflow_version WHERE workflow_id=w.id AND status='draft') draft_n
    FROM workflow w ORDER BY w.slug`)
    .all() as { id: number; slug: string; production_n: number | null; draft_n: number | null }[]
  return rows.map((row) => {
    const selected = versionRow(row.slug, row.production_n ?? row.draft_n ?? undefined, d)
    return {
      slug: row.slug,
      title: (JSON.parse(selected.definition) as WorkflowDefinition).title,
      production_n: row.production_n,
      draft_n: row.draft_n,
    }
  })
}
export function showWorkflow(slug: string, n?: number, d: Database = db()) {
  return parseVersion(versionRow(slug, n, d))
}

const workflowLifecycle = versionedLifecycle<WorkflowDefinition>({
  noun: 'workflow',
  identityTable: 'workflow',
  versionTable: 'workflow_version',
  eventTable: 'workflow_event',
  foreignKey: 'workflow_id',
  validate(value, d) {
    requireValid(value, d)
  },
})
function writeDraft(
  slug: string,
  definition: unknown,
  reasonValue: string | undefined,
  authorValue?: string,
  kind: Extract<VersionEvent, 'set' | 'fork' | 'import'> = 'set',
  d: Database = writableDb(),
) {
  requireSlug(slug)
  requireSlug(slug)
  return workflowLifecycle.write(slug, definition, reasonValue, authorValue, kind, d)
}
export const setWorkflow = (
  slug: string,
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => writeDraft(slug, definition, reason, author, 'set', d)

export function promoteWorkflow(
  slug: string,
  n: number,
  reasonValue: string | undefined,
  authorValue?: string,
  d: Database = writableDb(),
) {
  // A draft is validated against the catalogue it was written for; the
  // production catalogue may have dropped one of its steps since.
  return workflowLifecycle.promote(slug, n, reasonValue, authorValue, d, (definition, database) =>
    requireValid(definition, database),
  )
}
export function retireWorkflow(
  slug: string,
  n: number,
  reasonValue: string | undefined,
  authorValue?: string,
  d: Database = writableDb(),
) {
  return workflowLifecycle.retire(slug, n, reasonValue, authorValue, d)
}
export function forkWorkflow(
  slug: string,
  from: number | undefined,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) {
  const definition = (
    from === undefined
      ? workflowLifecycle.production(slug, d)
      : workflowLifecycle.show(slug, from, d)
  ).definition
  return writeDraft(slug, definition, reason, author, 'fork', d)
}
export function workflowVersions(slug: string, d: Database = db()) {
  return workflowLifecycle.versions(slug, d)
}

type WorkflowNeeds = {
  mode?: { slug: string; title: string; entry: string }[]
  arguments?: string[]
}
export function composeWorkflow(
  slug: string,
  projectName: string,
  modeSlug?: string,
  args: Record<string, string> = {},
  d: Database = db(),
) {
  const row = parseVersion(productionVersionRow(slug, d)),
    definition = row.definition,
    catalogue = productionStepCatalogue(d)
  const mode = modeSlug
    ? definition.modes.find((m) => m.slug === modeSlug)
    : definition.modes.find((m) => m.default)
  const needs: WorkflowNeeds = {}
  if (modeSlug && !mode) throw new Error(`workflow "${slug}" has no mode "${modeSlug}"`)
  if (!mode)
    needs.mode = definition.modes.map(({ slug, title, entry }) => ({ slug, title, entry: entry! }))
  const missing = definition.arguments
    .filter((arg) => arg.required && !args[arg.name])
    .map((arg) => arg.name)
  if (missing.length) needs.arguments = missing
  const projectRow = d
    .query('SELECT name,stack,settings FROM project WHERE name=? AND retired_at IS NULL')
    .get(projectName) as { name: string; stack: string | null; settings: string | null } | null
  if (!projectRow) throw new Error(`unknown project "${projectName}"`)
  const project = {
    name: projectRow.name,
    stack: projectRow.stack,
    settings: JSON.parse(projectRow.settings ?? '{}'),
  }
  const selected =
    mode?.steps.map(
      (stepSlug) => catalogue.definition.steps.find((step) => step.slug === stepSlug)!,
    ) ?? []
  const sources = [
    ...new Set(['docs', 'stack', ...selected.flatMap((step) => step.needs)]),
  ] as InjectionSource[]
  const facts = resolveInjection(project, sources)
  return {
    workflow: { slug, title: definition.title, version: row.n },
    project: projectName,
    catalogue: { version: catalogue.n },
    mode: mode ? { slug: mode.slug, title: mode.title } : null,
    arguments: args,
    steps:
      selected.map((step, index) => {
        return {
          n: index + 1,
          slug: step.slug,
          title: step.title,
          job: step.job,
          autonomy: step.autonomy,
          floor: step.floor,
          needs: step.needs,
        }
      }) ?? [],
    docs: {
      global: { scope: 'global' as const },
      stack: { scope: 'stack' as const, subject: facts.stack },
      project: facts.docs,
    },
    needs,
  }
}
export function getWorkflowStep(
  slug: string,
  projectName: string,
  stepSlug: string,
  args: Record<string, string> = {},
  d: Database = db(),
) {
  const row = parseVersion(productionVersionRow(slug, d)),
    definition = row.definition,
    catalogue = productionStepCatalogue(d),
    referenced = definition.modes.some((mode) => mode.steps.includes(stepSlug)),
    step = catalogue.definition.steps.find((item) => item.slug === stepSlug)
  if (!referenced || !step) throw new Error(`workflow "${slug}" has no step "${stepSlug}"`)
  const missing = definition.arguments
    .filter((arg) => arg.required && !args[arg.name])
    .map((arg) => arg.name)
  if (missing.length) throw new Error(`missing required arguments: ${missing.join(', ')}`)
  const projectRow = d
    .query('SELECT name,stack,settings FROM project WHERE name=? AND retired_at IS NULL')
    .get(projectName) as { name: string; stack: string | null; settings: string | null } | null
  if (!projectRow) throw new Error(`unknown project "${projectName}"`)
  const project = {
    name: projectRow.name,
    stack: projectRow.stack,
    settings: JSON.parse(projectRow.settings ?? '{}'),
  }
  const facts = resolveInjection(project, step.needs)
  const values: Record<string, unknown> = { ...args, ...facts }
  const body = step.body.replace(/\{\{([^{}]+)\}\}/g, (_all, path: string) => {
    let value: unknown = values
    for (const part of path.split('.')) value = object(value) ? value[part] : undefined
    if (value === undefined || value === null || typeof value === 'object')
      throw new Error(`unresolved workflow placeholder "${path}"`)
    return String(value)
  })
  return {
    ...step,
    workflow: slug,
    version: row.n,
    catalogueVersion: catalogue.n,
    project: projectName,
    body,
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (!object(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  )
}
const pretty = (value: unknown) => `${JSON.stringify(sorted(value), null, 2)}\n`
export function exportWorkflows(dir: string, d: Database = db()): void {
  mkdirSync(dir, { recursive: true })
  for (const workflow of listWorkflows(d)) {
    const target = join(dir, workflow.slug)
    mkdirSync(target, { recursive: true })
    const versions = workflowVersions(workflow.slug, d)
    for (const version of versions)
      writeFileSync(
        join(target, `v${version.n}.json`),
        pretty(showWorkflow(workflow.slug, Number(version.n), d).definition),
      )
    writeFileSync(
      join(target, 'README.md'),
      `# ${workflow.slug}\n\n${versions.map((v) => `- v${v.n}: ${v.status}`).join('\n')}\n`,
    )
  }
}
export function importWorkflows(
  dir: string,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) {
  required(reason, 'reason')
  if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`)
  const definitions: { slug: string; definition: unknown }[] = []
  for (const slug of readdirSync(dir).sort()) {
    const folder = join(dir, slug)
    const files = readdirSync(folder)
      .filter((f) => /^v\d+\.json$/.test(f))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    for (const file of files) {
      const definition = JSON.parse(readFileSync(join(folder, file), 'utf8'))
      requireSlug(slug)
      requireValid(definition, d)
      definitions.push({ slug, definition })
    }
  }
  // vN.json only orders the read. Each file becomes a new draft at MAX(n)+1;
  // import does not restore version numbers or statuses.
  return writeTransaction(
    () =>
      definitions.map(({ slug, definition }) =>
        writeDraft(slug, definition, reason, author, 'import', d),
      ),
    d,
  )
}
