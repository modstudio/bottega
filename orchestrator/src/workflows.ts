import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, nowIso, sessionId } from './db.ts'
import { JOBS } from './jobs.ts'

export type WorkflowArgument = { name: string; required: boolean; description: string }
export type WorkflowMode = { slug: string; title: string; default?: boolean; entry?: string; steps: string[] }
export type WorkflowStep = {
  slug: string; title: string; job: string | null; autonomy: 'auto' | 'ask' | 'manual'
  gate: string | null; body: string
}
export type WorkflowDefinition = {
  title: string; description: string; arguments: WorkflowArgument[]
  modes: WorkflowMode[]
  // Steps live inside one workflow because a step's body, job, and autonomy
  // only make sense in that workflow's arguments and modes. Sharing a step
  // across workflows would let a change in one silently rewrite another,
  // which is the opposite of versioned definitions. Cross-workflow reuse is
  // composing jobs, not steps — so the definition is one JSON blob, not a
  // step table.
  steps: WorkflowStep[]
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' ? value : ''

export function validateWorkflowDefinition(value: unknown): string[] {
  const errors: string[] = []
  if (!object(value)) return ['definition must be an object']
  if (typeof value.title !== 'string') errors.push('title must be a string')
  else if (!value.title.trim()) errors.push('title must be non-empty')
  if (typeof value.description !== 'string') errors.push('description must be a string')
  const args = Array.isArray(value.arguments) ? value.arguments : []
  const modes = Array.isArray(value.modes) ? value.modes : []
  const steps = Array.isArray(value.steps) ? value.steps : []
  if (!Array.isArray(value.arguments)) errors.push('arguments must be an array')
  if (!Array.isArray(value.modes)) errors.push('modes must be an array')
  if (!Array.isArray(value.steps)) errors.push('steps must be an array')

  for (const [index, argument] of args.entries()) {
    if (!object(argument)) { errors.push(`argument ${index + 1} must be an object`); continue }
    if (typeof argument.name !== 'string') errors.push(`argument ${index + 1} name must be a string`)
    if (typeof argument.required !== 'boolean') errors.push(`argument "${text(argument.name)}" required must be a boolean`)
    if (typeof argument.description !== 'string') errors.push(`argument "${text(argument.name)}" description must be a string`)
  }
  for (const [index, mode] of modes.entries()) {
    if (!object(mode)) { errors.push(`mode ${index + 1} must be an object`); continue }
    if (typeof mode.slug !== 'string') errors.push(`mode ${index + 1} slug must be a string`)
    if (typeof mode.title !== 'string') errors.push(`mode "${text(mode.slug)}" title must be a string`)
    if (mode.default !== undefined && typeof mode.default !== 'boolean') errors.push(`mode "${text(mode.slug)}" default must be a boolean`)
    if (mode.entry !== undefined && typeof mode.entry !== 'string') errors.push(`mode "${text(mode.slug)}" entry must be a string`)
    if (!Array.isArray(mode.steps) || mode.steps.some((step) => typeof step !== 'string')) errors.push(`mode "${text(mode.slug)}" steps must be a string array`)
  }
  for (const [index, step] of steps.entries()) {
    if (!object(step)) { errors.push(`step ${index + 1} must be an object`); continue }
    const slug = text(step.slug)
    if (typeof step.slug !== 'string') errors.push(`step ${index + 1} slug must be a string`)
    if (typeof step.title !== 'string') errors.push(`step "${slug}" title must be a string`)
    if (step.job !== null && typeof step.job !== 'string') errors.push(`step "${slug}" job must be a string or null`)
    if (typeof step.autonomy !== 'string') errors.push(`step "${slug}" autonomy must be a string`)
    if (step.gate !== null && typeof step.gate !== 'string') errors.push(`step "${slug}" gate must be a string or null`)
    if (typeof step.body !== 'string') errors.push(`step "${slug}" body must be a string`)
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
  checkSlugs(args.map((arg) => object(arg) ? { slug: arg.name } : arg), 'argument')
  checkSlugs(modes, 'mode')
  checkSlugs(steps, 'step')

  const defaults = modes.filter((mode) => object(mode) && mode.default === true)
  if (defaults.length > 1) errors.push('exactly one default mode is allowed')
  if (defaults.length === 0) {
    for (const mode of modes) {
      if (!object(mode) || !text(mode.entry).trim()) {
        errors.push(`mode "${object(mode) ? text(mode.slug) : ''}" needs an entry question when there is no default`)
      }
    }
  } else {
    for (const mode of modes) {
      if (object(mode) && text(mode.entry).trim()) {
        errors.push(`mode "${text(mode.slug)}" has an unreachable entry question beside a default mode`)
      }
    }
  }

  const stepNames = new Set(steps.filter(object).map((step) => text(step.slug)))
  const referenced = new Set<string>()
  for (const mode of modes) {
    if (!object(mode)) continue
    if (!Array.isArray(mode.steps) || mode.steps.length === 0) {
      errors.push(`mode "${text(mode.slug)}" must contain at least one step`)
      continue
    }
    for (const ref of mode.steps) {
      if (typeof ref !== 'string' || !stepNames.has(ref)) errors.push(`mode "${text(mode.slug)}" references missing step "${String(ref)}"`)
      else referenced.add(ref)
    }
  }
  for (const step of steps) {
    if (!object(step)) continue
    const slug = text(step.slug)
    if (!referenced.has(slug)) errors.push(`step "${slug}" is orphaned`)
    if (!text(step.title).trim()) errors.push(`step "${slug}" title must be non-empty`)
    if (step.job !== null && (typeof step.job !== 'string' || !(step.job in JOBS))) errors.push(`step "${slug}" names unknown job "${String(step.job)}"`)
    if (!['auto','ask','manual'].includes(text(step.autonomy))) errors.push(`step "${slug}" has invalid autonomy "${String(step.autonomy)}"`)
  }
  const declared = new Set(args.filter(object).map((arg) => text(arg.name)))
  for (const step of steps) {
    if (!object(step) || typeof step.body !== 'string') continue
    for (const match of step.body.matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (!declared.has(match[1]!)) errors.push(`step "${text(step.slug)}" uses undeclared argument "${match[1]}"`)
    }
  }
  return [...new Set(errors)]
}

function requireValid(value: unknown): asserts value is WorkflowDefinition {
  const errors = validateWorkflowDefinition(value)
  if (errors.length) throw new Error(`invalid workflow definition:\n${errors.map((e) => `- ${e}`).join('\n')}`)
}
function requireSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new Error('invalid slug; use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit')
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value.trim()
}
// Explicit --author, else this session id, else 'unknown'. Same fallback as
// docs.writeIdentity; the value is an actor id, not a display name.
function writeAuthor(author?: string): string {
  return author?.trim() || sessionId() || 'unknown'
}

type VersionRow = { id: number; workflow_id: number; slug: string; n: number; status: 'draft'|'production'|'retired'; definition: string; author: string; reason: string; created_at: string; promoted_at: string|null; retired_at: string|null }
function workflowId(slug: string, d: Database = db()): number {
  const row = d.query('SELECT id FROM workflow WHERE slug=?').get(slug) as { id: number } | null
  if (!row) throw new Error(`unknown workflow "${slug}"`)
  return row.id
}
function versionRow(slug: string, n?: number, d: Database = db()): VersionRow {
  // Unqualified show prefers production, then the newest draft, then the
  // newest retired. A newer draft must not shadow live production.
  const where = n === undefined
    ? `ORDER BY CASE status WHEN 'production' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, n DESC LIMIT 1`
    : `AND v.n=?`
  const row = d.query(`SELECT v.*, w.slug FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? ${where}`)
    .get(...(n === undefined ? [slug] : [slug, n])) as VersionRow | null
  if (!row) throw new Error(n === undefined ? `unknown workflow "${slug}"` : `workflow "${slug}" has no version ${n}`)
  return row
}
const parseVersion = (row: VersionRow) =>
  ({ ...row, definition: JSON.parse(row.definition) as WorkflowDefinition })

function productionVersionRow(slug: string, d: Database = db()): VersionRow {
  const row = d.query(`SELECT v.*, w.slug FROM workflow_version v
    JOIN workflow w ON w.id=v.workflow_id
    WHERE w.slug=? AND v.status='production'`).get(slug) as VersionRow | null
  if (!row) throw new Error(`workflow "${slug}" has no production version; promote one`)
  return row
}

export function listWorkflows(d: Database = db()) {
  const rows = d.query(`SELECT w.id,w.slug,
    (SELECT n FROM workflow_version WHERE workflow_id=w.id AND status='production') production_n,
    (SELECT MAX(n) FROM workflow_version WHERE workflow_id=w.id AND status='draft') draft_n
    FROM workflow w ORDER BY w.slug`).all() as {id:number;slug:string;production_n:number|null;draft_n:number|null}[]
  return rows.map((row) => {
    const selected = versionRow(row.slug, row.production_n ?? row.draft_n ?? undefined, d)
    return { slug: row.slug, title: (JSON.parse(selected.definition) as WorkflowDefinition).title, production_n: row.production_n, draft_n: row.draft_n }
  })
}
export function showWorkflow(slug: string, n?: number, d: Database = db()) { return parseVersion(versionRow(slug, n, d)) }

function recordEvent(d: Database, workflow: number, n: number, kind: 'set'|'fork'|'import'|'promote'|'retire', author: string, reason: string, at: string) {
  d.query(`INSERT INTO workflow_event (workflow_id,version_n,event,author,reason,session_id,at) VALUES (?,?,?,?,?,?,?)`)
    .run(workflow, n, kind, author, reason, sessionId(), at)
}
function writeDraft(slug: string, definition: unknown, reasonValue: string | undefined, authorValue?: string, kind: 'set'|'fork'|'import' = 'set', d: Database = db()) {
  requireSlug(slug); requireValid(definition)
  const reason = required(reasonValue, 'reason'); const author = writeAuthor(authorValue); const at = nowIso()
  return d.transaction(() => {
    let row = d.query('SELECT id FROM workflow WHERE slug=?').get(slug) as {id:number}|null
    if (!row) row = d.query('INSERT INTO workflow (slug,created_at) VALUES (?,?) RETURNING id').get(slug,at) as {id:number}
    const max = d.query('SELECT COALESCE(MAX(n),0) n FROM workflow_version WHERE workflow_id=?').get(row.id) as {n:number}
    const n = max.n + 1
    d.query(`INSERT INTO workflow_version (workflow_id,n,status,definition,author,reason,created_at) VALUES (?,?,'draft',?,?,?,?)`)
      .run(row.id,n,JSON.stringify(definition),author,reason,at)
    // A new identity's first event is the operation that produced its version.
    recordEvent(d,row.id,n,kind,author,reason,at)
    return showWorkflow(slug,n,d)
  })()
}
export const setWorkflow = (slug:string, definition:unknown, reason:string|undefined, author?:string, d:Database=db()) => writeDraft(slug,definition,reason,author,'set',d)

export function promoteWorkflow(slug:string,n:number,reasonValue:string|undefined,authorValue?:string,d:Database=db()) {
  const reason = required(reasonValue, 'reason')
  const author = writeAuthor(authorValue)
  const at = nowIso()
  const id = workflowId(slug, d)
  return d.transaction(() => {
    const target=d.query('SELECT status FROM workflow_version WHERE workflow_id=? AND n=?').get(id,n) as {status:string}|null
    if (!target || target.status !== 'draft') throw new Error(`workflow "${slug}" version ${n} is not a draft`)
    // Promoting replaces production. Retire the prior row in this transaction
    // so the unique production index holds; the retire event reuses this
    // promote reason — there is no separate withdraw.
    const prior=d.query(`SELECT n FROM workflow_version WHERE workflow_id=? AND status='production'`).get(id) as {n:number}|null
    d.query(`UPDATE workflow_version SET status='retired',retired_at=? WHERE workflow_id=? AND status='production'`).run(at,id)
    if (prior) recordEvent(d,id,prior.n,'retire',author,reason,at)
    d.query(`UPDATE workflow_version SET status='production',promoted_at=? WHERE workflow_id=? AND n=?`).run(at,id,n)
    recordEvent(d,id,n,'promote',author,reason,at)
    return showWorkflow(slug,n,d)
  })()
}
export function retireWorkflow(slug:string,n:number,reasonValue:string|undefined,authorValue?:string,d:Database=db()) {
  const reason = required(reasonValue, 'reason')
  const author = writeAuthor(authorValue)
  const at = nowIso()
  const id = workflowId(slug, d)
  return d.transaction(() => {
    const target=d.query('SELECT status FROM workflow_version WHERE workflow_id=? AND n=?').get(id,n) as {status:string}|null
    if (!target || target.status !== 'production') throw new Error(`workflow "${slug}" version ${n} is not production`)
    d.query(`UPDATE workflow_version SET status='retired',retired_at=? WHERE workflow_id=? AND n=?`).run(at,id,n)
    recordEvent(d,id,n,'retire',author,reason,at); return showWorkflow(slug,n,d)
  })()
}
export function forkWorkflow(slug:string,from:number|undefined,reason:string|undefined,author?:string,d:Database=db()) {
  const source=from === undefined
    ? d.query(`SELECT n FROM workflow_version WHERE workflow_id=? AND status='production'`).get(workflowId(slug,d)) as {n:number}|null
    : {n:from}
  if (!source) throw new Error(`workflow "${slug}" has no production version to fork`)
  const definition=showWorkflow(slug,source.n,d).definition
  return writeDraft(slug,definition,reason,author,'fork',d)
}
export function workflowVersions(slug:string,d:Database=db()) {
  const id=workflowId(slug,d)
  const versions=d.query('SELECT n,status,author,reason,created_at,promoted_at,retired_at FROM workflow_version WHERE workflow_id=? ORDER BY n').all(id) as {n:number;status:string;author:string;reason:string;created_at:string;promoted_at:string|null;retired_at:string|null}[]
  return versions.map((version) => ({...version,events:d.query('SELECT event,author,reason,session_id,at FROM workflow_event WHERE workflow_id=? AND version_n=? ORDER BY id').all(id,version.n)}))
}

export type WorkflowNeeds = { mode?: {slug:string;title:string;entry:string}[]; arguments?: string[] }
export function composeWorkflow(slug:string,modeSlug?:string,args:Record<string,string>={},d:Database=db()) {
  const row=parseVersion(productionVersionRow(slug,d)), definition=row.definition
  let mode=modeSlug ? definition.modes.find((m)=>m.slug===modeSlug) : definition.modes.find((m)=>m.default)
  const needs:WorkflowNeeds={}
  if (modeSlug && !mode) throw new Error(`workflow "${slug}" has no mode "${modeSlug}"`)
  if (!mode) needs.mode=definition.modes.map(({slug,title,entry})=>({slug,title,entry:entry!}))
  const missing=definition.arguments.filter((arg)=>arg.required && !args[arg.name]).map((arg)=>arg.name)
  if (missing.length) needs.arguments=missing
  return { workflow:{slug,title:definition.title,version:row.n}, mode:mode ? {slug:mode.slug,title:mode.title} : null,
    arguments:args, steps:mode?.steps.map((stepSlug,index)=>{const step=definition.steps.find((s)=>s.slug===stepSlug)!;return {n:index+1,slug:step.slug,title:step.title,job:step.job,autonomy:step.autonomy,gate:step.gate}}) ?? [], needs }
}
export function getWorkflowStep(slug:string,stepSlug:string,args:Record<string,string>={},d:Database=db()) {
  const row=parseVersion(productionVersionRow(slug,d)), definition=row.definition, step=definition.steps.find((item)=>item.slug===stepSlug)
  if (!step) throw new Error(`workflow "${slug}" has no step "${stepSlug}"`)
  const missing=definition.arguments.filter((arg)=>arg.required && !args[arg.name]).map((arg)=>arg.name)
  if (missing.length) throw new Error(`missing required arguments: ${missing.join(', ')}`)
  const body=step.body.replace(/\{\{([^{}]+)\}\}/g,(_all,name:string)=>args[name] ?? '')
  return {...step,workflow:slug,version:row.n,body}
}

function sorted(value:unknown):unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (!object(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,sorted(value[key])]))
}
const pretty=(value:unknown)=>`${JSON.stringify(sorted(value),null,2)}\n`
export function exportWorkflows(dir:string,d:Database=db()):void {
  mkdirSync(dir,{recursive:true})
  for (const workflow of listWorkflows(d)) {
    const target=join(dir,workflow.slug); mkdirSync(target,{recursive:true})
    const versions=workflowVersions(workflow.slug,d)
    for (const version of versions) writeFileSync(join(target,`v${version.n}.json`),pretty(showWorkflow(workflow.slug,Number(version.n),d).definition))
    writeFileSync(join(target,'README.md'),`# ${workflow.slug}\n\n${versions.map((v)=>`- v${v.n}: ${v.status}`).join('\n')}\n`)
  }
}
export function importWorkflows(dir:string,reason:string|undefined,author?:string,d:Database=db()) {
  required(reason,'reason'); if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`)
  const definitions:{slug:string;definition:unknown}[]=[]
  for (const slug of readdirSync(dir).sort()) {
    const folder=join(dir,slug); const files=readdirSync(folder).filter((f)=>/^v\d+\.json$/.test(f)).sort((a,b)=>Number(a.slice(1))-Number(b.slice(1)))
    for (const file of files) {
      const definition=JSON.parse(readFileSync(join(folder,file),'utf8')); requireSlug(slug); requireValid(definition)
      definitions.push({slug,definition})
    }
  }
  // vN.json only orders the read. Each file becomes a new draft at MAX(n)+1;
  // import does not restore version numbers or statuses.
  return d.transaction(()=>definitions.map(({slug,definition})=>writeDraft(slug,definition,reason,author,'import',d)))()
}
