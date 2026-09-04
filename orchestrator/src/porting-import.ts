import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { db } from './db.ts'
import { setDoc } from './docs.ts'
import {
  addDoctrineRule, addPair, addSkip, setBaseline, setLedgerRef,
} from './porting.ts'
import type { Project } from './projects.ts'

export type ImportIssue = {
  kind: 'refusal' | 'exclusion'
  what: string
  where: string
  why: string
  value?: string
}
export type ImportRefusal = ImportIssue & { kind: 'refusal' }
export type ImportExclusion = ImportIssue & { kind: 'exclusion' }

export type ImportPlan = {
  pairs: { source: string; target: string; sourceId: number; targetId: number }[]
  baselines: { pairKey: string; sourceCommit: string | null; scannedAt: string | null }[]
  skips: { pairKey: string; candidate: string; reason: string }[]
  refs: {
    taskKey: string
    note: string
    sources: { source_project_id: number; commits: string[]; paths: string[]; note: string }[]
  }[]
  doctrine: { number: number; title: string; body: string }[]
  docs: { scope: string; subject: string | null; slug: string; title: string; body: string }[]
  refusals: ImportRefusal[]
  exclusions: ImportExclusion[]
}

export type ImportFiles = {
  doctrine: string
  differences: string
  backports: string
  refs: string
  state: string
  projects: string
}

export type SourceCoverageGap = { file: string; offset: number; text: string }

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function refusal(what: string, where: string, why: string): ImportRefusal {
  return { kind: 'refusal', what, where, why }
}

function exclusion(what: string, where: string, why: string, value?: string): ImportExclusion {
  return { kind: 'exclusion', what, where, why, ...(value === undefined ? {} : { value }) }
}

function jsonObject(text: string, where: string, refusals: ImportRefusal[]): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    refusals.push(refusal('invalid JSON', where, String(error)))
    return null
  }
  if (!object(value)) {
    refusals.push(refusal('invalid document', where, 'expected a JSON object'))
    return null
  }
  return value
}

/** Return complete Markdown sections, with end-of-string as the final boundary. */
function sections(markdown: string, level: 2 | 3): { heading: string; name: string; body: string }[] {
  const headings = [...markdown.matchAll(/^(#{1,3}) (.+)$/gm)]
  const matches = headings.filter((match) => match[1]!.length === level)
  return matches.map((match) => {
    const start = match.index!
    const end = headings.find((candidate) =>
      candidate.index! > start && candidate[1]!.length <= level)?.index ?? markdown.length
    return { heading: match[0], name: match[2]!.trim(), body: markdown.slice(start, end).trimEnd() }
  })
}

function namedSection(markdown: string, name: string): string | null {
  return sections(markdown, 2).find((section) => section.name === name)?.body ?? null
}

function mark(marks: Uint8Array, start: number, end: number): void {
  for (let index = start; index < end; index++) marks[index] = 1
}

function markdownMarks(plan: ImportPlan, files: ImportFiles): Map<keyof ImportFiles, Uint8Array> {
  const result = new Map<keyof ImportFiles, Uint8Array>()
  for (const key of ['doctrine', 'differences', 'backports', 'projects'] as const) {
    result.set(key, new Uint8Array(files[key].length))
  }
  const markBody = (key: 'differences' | 'backports' | 'projects', body: string) => {
    const start = files[key].indexOf(body)
    if (start >= 0) mark(result.get(key)!, start, start + body.length)
  }

  const doctrineRules = [...files.doctrine.matchAll(/^(\d+)\. \*\*(.+?)\*\*([^\r\n]*)(?:\r?\n|$)/gm)]
  const first = doctrineRules[0]
  const preface = plan.docs.find((doc) => doc.slug === 'port-doctrine-preface')
  if (first && preface?.body === files.doctrine.slice(0, first.index).trimEnd()) {
    mark(result.get('doctrine')!, 0, preface.body.length)
  }
  doctrineRules.forEach((match, index) => {
    const end = doctrineRules[index + 1]?.index ?? files.doctrine.length
    const opening = match[3]!.trim()
    const continuation = files.doctrine.slice(match.index! + match[0].length, end).trim()
    const body = [opening, continuation].filter(Boolean).join('\n')
    if (plan.doctrine.some((rule) =>
      rule.number === Number(match[1]) && rule.title === match[2]!.trim() && rule.body === body)) {
      mark(result.get('doctrine')!, match.index!, end)
    }
  })

  for (const section of sections(files.differences, 2)) {
    if (plan.docs.some((doc) =>
      ['port-stack-mapping', 'port-process-differences'].includes(doc.slug) && doc.body === section.body)) {
      markBody('differences', section.body)
    }
  }
  for (const section of sections(files.differences, 3)) {
    if (plan.docs.some((doc) =>
      ['port-differences', 'port-differences-unassigned'].includes(doc.slug) && doc.body.includes(section.body))) {
      markBody('differences', section.body)
    }
  }
  for (const section of sections(files.backports, 2)) {
    if (plan.docs.some((doc) => doc.slug === 'port-backports' && doc.body === section.body)) {
      markBody('backports', section.body)
    }
  }
  for (const section of sections(files.projects, 2)) {
    const imported = plan.docs.some((doc) => doc.slug === 'port-category-map' && doc.body.includes(section.body))
    const excluded = plan.exclusions.some((issue) =>
      issue.where === 'projects.md' && issue.value?.includes(section.body))
    if (imported || excluded) markBody('projects', section.body)
  }
  return result
}

function gapsFromMarks(
  files: ImportFiles, marks: Map<keyof ImportFiles, Uint8Array>,
): SourceCoverageGap[] {
  const gaps: SourceCoverageGap[] = []
  const names: Record<'doctrine' | 'differences' | 'backports' | 'projects', string> = {
    doctrine: 'doctrine.md', differences: 'differences.md', backports: 'backports.md', projects: 'projects.md',
  }
  for (const key of Object.keys(names) as (keyof typeof names)[]) {
    const text = files[key]
    const covered = marks.get(key)!
    let start = 0
    while (start < text.length) {
      while (start < text.length && covered[start]) start++
      let end = start
      while (end < text.length && !covered[end]) end++
      if (/\S/.test(text.slice(start, end))) gaps.push({ file: names[key], offset: start, text: text.slice(start, end) })
      start = end
    }
  }
  return gaps
}

function sourceContextBody(gaps: SourceCoverageGap[]): string {
  return gaps.map((gap) =>
    `## ${gap.file} offset ${gap.offset}\n\n${gap.text}`,
  ).join('\n\n---\n\n')
}

function registeredByName(registered: Project[]): Map<string, Project[]> {
  const result = new Map<string, Project[]>()
  for (const project of registered) result.set(project.name, [...(result.get(project.name) ?? []), project])
  return result
}

function resolveProject(
  name: string, where: string, byName: Map<string, Project[]>, refusals: ImportRefusal[],
): Project | null {
  const matches = byName.get(name) ?? []
  if (matches.length === 1) return matches[0]!
  refusals.push(refusal(
    `project "${name}"`, where,
    matches.length === 0 ? 'no registered project has this name' : 'several registered projects have this name',
  ))
  return null
}

function originalValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function stateSupplementBody(state: Record<string, unknown>): string {
  const entries = Object.entries(state)
    .filter(([key]) => key !== 'pairs')
    .map(([key, value]) => [`state.json ${key}`, value] as const)
  if (object(state.pairs)) {
    for (const [pairKey, pair] of Object.entries(state.pairs)) {
      if (!object(pair) || !Array.isArray(pair.skipped)) continue
      pair.skipped.forEach((skip, index) => {
        if (!object(skip)) return
        const extra = Object.fromEntries(Object.entries(skip).filter(([key]) => !['feature', 'reason'].includes(key)))
        if (Object.keys(extra).length) entries.push([
          `state.json pairs["${pairKey}"].skipped[${index}] supplemental fields`, extra,
        ])
      })
    }
  }
  return entries.map(([where, value]) => `${where}\n${originalValue(value)}`).join('\n\n')
}

function targetForTaskKey(taskKey: string, registered: Project[], refusals: ImportRefusal[]): Project | null {
  const where = `refs.json ${taskKey}`
  const prefix = taskKey.match(/^([A-Za-z][A-Za-z0-9]*)-\d+$/)?.[1]
  if (!prefix) {
    refusals.push(refusal(`task key "${taskKey}"`, where, 'invalid target task key'))
    return null
  }
  const matches = registered.filter((project) => project.settings.keyPrefixes?.includes(prefix))
  if (matches.length !== 1) {
    refusals.push(refusal(
      `task key "${taskKey}"`, where, matches.length === 0
        ? 'no registered project owns this task key'
        : 'several registered projects own this task key',
    ))
    return null
  }
  return matches[0]!
}

function parseState(text: string, plan: ImportPlan, byName: Map<string, Project[]>): void {
  const state = jsonObject(text, 'state.json', plan.refusals)
  if (!state) return
  if (!object(state.pairs)) {
    plan.refusals.push(refusal('pairs', 'state.json', 'expected an object'))
    return
  }
  const supplement = stateSupplementBody(state)
  if (supplement) {
    plan.docs.push({
      scope: 'global', subject: null, slug: 'port-state-metadata', title: 'Port state metadata',
      body: supplement,
    })
  }
  for (const [pairKey, value] of Object.entries(state.pairs)) {
    const where = `state.json pairs["${pairKey}"]`
    const names = pairKey.match(/^(.+)->(.+)$/)
    if (!names || !object(value)) {
      plan.refusals.push(refusal(`pair "${pairKey}"`, where, 'expected a source->target object'))
      continue
    }
    const source = resolveProject(names[1]!, where, byName, plan.refusals)
    const target = resolveProject(names[2]!, where, byName, plan.refusals)
    if (source && target) {
      if (source.id === target.id) {
        plan.refusals.push(refusal(`pair "${pairKey}"`, where, 'source and target are the same project'))
      } else {
        plan.pairs.push({ source: source.name, target: target.name, sourceId: source.id, targetId: target.id })
      }
    }

    for (const field of ['note', 'notes', 'scope', 'staged']) {
      if (Object.hasOwn(value, field)) {
        plan.exclusions.push(exclusion(
          `pair field "${field}"`, `${where}.${field}`,
          'the port schema has no column for this content', originalValue(value[field]),
        ))
      }
    }
    const knownPairFields = new Set(['lastPortedSha', 'scannedAt', 'skipped', 'note', 'notes', 'scope', 'staged'])
    for (const field of Object.keys(value).filter((candidate) => !knownPairFields.has(candidate))) {
      plan.exclusions.push(exclusion(
        `pair field "${field}"`, `${where}.${field}`,
        'this field has no defined import destination', originalValue(value[field]),
      ))
    }

    const sourceCommit = value.lastPortedSha
    const scannedAt = value.scannedAt
    const validCommit = sourceCommit === null || typeof sourceCommit === 'string'
    const validScanned = scannedAt === null || scannedAt === undefined || typeof scannedAt === 'string'
    if (!validCommit || !validScanned) {
      plan.exclusions.push(exclusion(
        'baseline', where,
        sourceCommit === undefined
          ? 'lastPortedSha is missing'
          : 'lastPortedSha and scannedAt must be strings or null',
        JSON.stringify({ lastPortedSha: sourceCommit, scannedAt }),
      ))
    } else if ((sourceCommit === null) !== (scannedAt == null)) {
      plan.exclusions.push(exclusion(
        'baseline', where, 'source commit and scannedAt must either both be null or both be non-null',
        JSON.stringify({ lastPortedSha: sourceCommit, scannedAt }),
      ))
    } else if (source && target && source.id !== target.id) {
      plan.baselines.push({ pairKey, sourceCommit, scannedAt: scannedAt ?? null })
    }

    if (value.skipped === undefined) continue
    if (!Array.isArray(value.skipped)) {
      plan.refusals.push(refusal('skipped candidates', `${where}.skipped`, 'expected an array'))
      continue
    }
    value.skipped.forEach((skip, index) => {
      const skipWhere = `${where}.skipped[${index}]`
      if (typeof skip === 'string') {
        if (source && target && source.id !== target.id) {
          plan.skips.push({
            pairKey, candidate: skip,
            reason: 'recorded in the source with no separate reason; the candidate text is the entire record',
          })
        }
        return
      }
      if (!object(skip) || typeof skip.feature !== 'string' || typeof skip.reason !== 'string') {
        plan.refusals.push(refusal('skip', skipWhere, 'expected an object with string feature and reason fields'))
        return
      }
      if (source && target && source.id !== target.id) {
        plan.skips.push({ pairKey, candidate: skip.feature, reason: skip.reason })
      }
    })
  }
}

function parseRefs(
  text: string, registered: Project[], plan: ImportPlan, byName: Map<string, Project[]>,
): void {
  const refs = jsonObject(text, 'refs.json', plan.refusals)
  if (!refs) return
  const metadata = Object.entries(refs).filter(([key]) => key.startsWith('_'))
  if (metadata.length) {
    plan.docs.push({
      scope: 'global', subject: null, slug: 'port-ref-metadata', title: 'Port reference metadata',
      body: metadata.map(([key, value]) => `${key}\n${originalValue(value)}`).join('\n\n'),
    })
  }
  for (const [taskKey, value] of Object.entries(refs)) {
    if (taskKey.startsWith('_')) continue
    const where = `refs.json ${taskKey}`
    const target = targetForTaskKey(taskKey, registered, plan.refusals)
    if (!object(value)) {
      plan.refusals.push(refusal(`ledger ref "${taskKey}"`, where, 'expected an object'))
      continue
    }
    const sources: { project: Project; note: string }[] = []
    if (typeof value.source !== 'string') {
      plan.refusals.push(refusal(`ledger ref "${taskKey}"`, where, 'source must name registered projects'))
    } else {
      for (const part of value.source.split(' + ')) {
        const names = [...byName.keys()].filter((name) => part === name || part.startsWith(`${name} (`))
        if (names.length !== 1) {
          resolveProject(part, where, byName, plan.refusals)
          continue
        }
        const name = names[0]!
        const project = resolveProject(name, where, byName, plan.refusals)
        if (project) sources.push({ project, note: part.slice(name.length) })
      }
    }
    const commits = value.commits
    const paths = value.paths
    const notes = value.notes
    if (!Array.isArray(commits) || !commits.every((item) => typeof item === 'string') ||
        !Array.isArray(paths) || !paths.every((item) => typeof item === 'string') ||
        typeof notes !== 'string') {
      plan.refusals.push(refusal(
        `ledger ref "${taskKey}"`, where,
        'commits and paths must be string arrays and notes must be a string',
      ))
      continue
    }
    const unknown = Object.keys(value).filter((field) => !['source', 'commits', 'paths', 'notes'].includes(field))
    if (unknown.length) {
      for (const field of unknown) {
        plan.exclusions.push(exclusion(
          `ledger field "${field}"`, `${where}.${field}`,
          'this field has no defined import destination', originalValue(value[field]),
        ))
      }
    }
    if (target && sources.length > 0 &&
        new Set(sources.map((source) => source.project.id)).size === sources.length) {
      plan.refs.push({
        taskKey, note: notes,
        sources: sources.map((source) => ({
          source_project_id: source.project.id, commits, paths, note: source.note,
        })),
      })
    } else if (sources.length > 1 &&
               new Set(sources.map((source) => source.project.id)).size !== sources.length) {
      plan.refusals.push(refusal(`ledger ref "${taskKey}"`, where, 'a source project is named more than once'))
    }
  }
}

function parseDoctrine(markdown: string, plan: ImportPlan): void {
  const rule = /^(\d+)\. \*\*(.+?)\*\*([^\r\n]*)(?:\r?\n|$)/gm
  const matches = [...markdown.matchAll(rule)]
  const first = matches[0]
  if (!first) {
    plan.refusals.push(refusal('doctrine rules', 'doctrine.md', 'no numbered rules found'))
    return
  }
  plan.docs.push({
    scope: 'global', subject: null, slug: 'port-doctrine-preface',
    title: 'Port doctrine preface', body: markdown.slice(0, first.index).trimEnd(),
  })
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!
    const end = matches[index + 1]?.index ?? markdown.length
    const number = Number(match[1])
    const opening = match[3]!.trim()
    const continuation = markdown.slice(match.index! + match[0].length, end).trim()
    plan.doctrine.push({
      number, title: match[2]!.trim(), body: [opening, continuation].filter(Boolean).join('\n'),
    })
  }
}

function parseDifferences(
  markdown: string, plan: ImportPlan, byName: Map<string, Project[]>,
): void {
  const fixed = [
    ['Stack mapping (how to translate, not a reason to skip)', 'port-stack-mapping', 'Port stack mapping'],
    ['Process differences', 'port-process-differences', 'Port process differences'],
  ] as const
  for (const [name, slug, title] of fixed) {
    const body = namedSection(markdown, name)
    if (body === null) {
      plan.refusals.push(refusal(`section "${name}"`, 'differences.md', 'section is missing'))
    } else {
      plan.docs.push({ scope: 'global', subject: null, slug, title, body })
    }
  }

  const projectBodies = new Map<string, string[]>()
  const unassigned: string[] = []
  for (const section of sections(markdown, 3)) {
    const matches = byName.get(section.name) ?? []
    if (matches.length === 1) {
      projectBodies.set(section.name, [...(projectBodies.get(section.name) ?? []), section.body])
    } else {
      unassigned.push(section.body)
    }
  }
  for (const [name, bodies] of projectBodies) {
    plan.docs.push({
      scope: 'project', subject: name, slug: 'port-differences', title: 'Port differences',
      body: bodies.join('\n\n'),
    })
  }
  if (unassigned.length) {
    plan.docs.push({
      scope: 'global', subject: null, slug: 'port-differences-unassigned',
      title: 'Unassigned port differences', body: unassigned.join('\n\n'),
    })
  }
}

function parseBackports(
  markdown: string, plan: ImportPlan, byName: Map<string, Project[]>,
): void {
  for (const section of sections(markdown, 2)) {
    const match = section.name.match(/^(?:→|->)\s*(.+)$/)
    if (!match) continue
    const name = match[1]!.trim()
    const project = resolveProject(name, `backports.md ${section.heading}`, byName, plan.refusals)
    if (project) {
      plan.docs.push({
        scope: 'project', subject: project.name, slug: 'port-backports',
        title: 'Port backports', body: section.body,
      })
    }
  }
}

function parseProjects(markdown: string, plan: ImportPlan): void {
  const category = namedSection(markdown, 'Category map')
  const references = namedSection(markdown, 'Reference implementations (deepest instance = default port source)')
  if (category === null || references === null) {
    plan.refusals.push(refusal(
      'category map', 'projects.md',
      'Category map and Reference implementations sections are both required',
    ))
  } else {
    plan.docs.push({
      scope: 'global', subject: null, slug: 'port-category-map', title: 'Port category map',
      body: `${category}\n\n${references}`,
    })
  }
  const excluded = sections(markdown, 2).filter((section) =>
    section.name === 'Resolving the workspace' || section.name.startsWith('Resolving the workspace (') ||
    section.name === 'Stacks')
  if (excluded.length) {
    plan.exclusions.push(exclusion(
      'workspace and stack sections', 'projects.md',
      'checkout layout, trunks, origins, and stacks are authoritative in the project register',
      excluded.map((section) => section.body).join('\n\n'),
    ))
  }
}

export function planImport(files: ImportFiles, registered: Project[]): ImportPlan {
  const plan: ImportPlan = {
    pairs: [], baselines: [], skips: [], refs: [], doctrine: [], docs: [], refusals: [], exclusions: [],
  }
  const byName = registeredByName(registered)
  parseState(files.state, plan, byName)
  parseRefs(files.refs, registered, plan, byName)
  parseDoctrine(files.doctrine, plan)
  parseDifferences(files.differences, plan, byName)
  parseBackports(files.backports, plan, byName)
  parseProjects(files.projects, plan)
  const context = gapsFromMarks(files, markdownMarks(plan, files))
  if (context.length) {
    plan.docs.push({
      scope: 'global', subject: null, slug: 'port-import-source-context', title: 'Port import source context',
      body: sourceContextBody(context),
    })
  }
  if (plan.exclusions.length) {
    plan.docs.push({
      scope: 'global', subject: null, slug: 'port-import-exclusions', title: 'Port import exclusions',
      body: plan.exclusions.map((exclusion) =>
        `${exclusion.what} / ${exclusion.where} / ${exclusion.why}` +
        (exclusion.value === undefined ? '' : `\n\nOriginal value:\n${exclusion.value}`),
      ).join('\n\n---\n\n'),
    })
  }
  return plan
}

function jsonCoverage(plan: ImportPlan, files: ImportFiles): SourceCoverageGap[] {
  const gaps: SourceCoverageGap[] = []
  const state = jsonObject(files.state, 'state.json', [])
  const stateSupplement = state ? stateSupplementBody(state) : ''
  const stateSupplementCovered = !stateSupplement || plan.docs.some((doc) =>
    doc.slug === 'port-state-metadata' && doc.body === stateSupplement)
  const statePairsCovered = state && object(state.pairs) && Object.entries(state.pairs).every(([pairKey, value]) => {
    if (!object(value) || !plan.pairs.some((pair) => `${pair.source}->${pair.target}` === pairKey)) return false
    const where = `state.json pairs["${pairKey}"]`
    const excludedFields = Object.keys(value).filter((field) =>
      !['lastPortedSha', 'scannedAt', 'skipped'].includes(field))
    if (!excludedFields.every((field) => plan.exclusions.some((issue) =>
      issue.where === `${where}.${field}` && issue.value === originalValue(value[field])))) return false

    const sourceCommit = value.lastPortedSha
    const scannedAt = value.scannedAt
    const validCommit = sourceCommit === null || typeof sourceCommit === 'string'
    const validScanned = scannedAt === null || scannedAt === undefined || typeof scannedAt === 'string'
    const validBaseline = validCommit && validScanned &&
      (sourceCommit === null) === (scannedAt == null)
    const baselineCovered = validBaseline
      ? plan.baselines.some((baseline) => baseline.pairKey === pairKey &&
          baseline.sourceCommit === sourceCommit && baseline.scannedAt === (scannedAt ?? null))
      : plan.exclusions.some((issue) => issue.what === 'baseline' && issue.where === where &&
          issue.value === JSON.stringify({ lastPortedSha: sourceCommit, scannedAt }))
    if (!baselineCovered) return false

    if (value.skipped === undefined) return true
    if (!Array.isArray(value.skipped)) return false
    return value.skipped.every((skip) => {
      const candidate = typeof skip === 'string' ? skip : object(skip) ? skip.feature : undefined
      const reason = typeof skip === 'string'
        ? 'recorded in the source with no separate reason; the candidate text is the entire record'
        : object(skip) ? skip.reason : undefined
      return typeof candidate === 'string' && typeof reason === 'string' &&
        plan.skips.some((row) => row.pairKey === pairKey && row.candidate === candidate && row.reason === reason)
    })
  })
  if (!state || !statePairsCovered || !stateSupplementCovered) {
    gaps.push({ file: 'state.json', offset: 0, text: files.state })
  }

  const refs = jsonObject(files.refs, 'refs.json', [])
  const metadata = refs ? Object.entries(refs).filter(([key]) => key.startsWith('_')) : []
  const metadataBody = metadata.map(([key, value]) => `${key}\n${originalValue(value)}`).join('\n\n')
  const refsCovered = refs && Object.entries(refs).filter(([key]) => !key.startsWith('_')).every(([taskKey, value]) => {
    if (!object(value) || typeof value.source !== 'string' || !Array.isArray(value.commits) ||
        !Array.isArray(value.paths) || typeof value.notes !== 'string') return false
    const row = plan.refs.find((ref) => ref.taskKey === taskKey)
    if (!row || row.note !== value.notes || row.sources.length !== value.source.split(' + ').length) return false
    if (!row.sources.every((source) =>
      JSON.stringify(source.commits) === JSON.stringify(value.commits) &&
      JSON.stringify(source.paths) === JSON.stringify(value.paths))) return false
    const qualifiers = value.source.split(' + ').map((part) => {
      const qualifier = part.indexOf(' (')
      return qualifier < 0 ? '' : part.slice(qualifier)
    })
    if (!qualifiers.every((note) => row.sources.some((source) => source.note === note))) return false
    return Object.keys(value).filter((field) => !['source', 'commits', 'paths', 'notes'].includes(field))
      .every((field) => plan.exclusions.some((issue) =>
        issue.where === `refs.json ${taskKey}.${field}` && issue.value === originalValue(value[field])))
  })
  if (!refs || !refsCovered ||
      (metadata.length > 0 && !plan.docs.some((doc) =>
        doc.slug === 'port-ref-metadata' && doc.body === metadataBody))) {
    gaps.push({ file: 'refs.json', offset: 0, text: files.refs })
  }
  return gaps
}

export function sourceCoverage(plan: ImportPlan, files: ImportFiles): SourceCoverageGap[] {
  const marks = markdownMarks(plan, files)
  const context = gapsFromMarks(files, marks)
  const contextDoc = plan.docs.find((doc) => doc.slug === 'port-import-source-context')
  if (context.length && contextDoc?.body === sourceContextBody(context)) {
    for (const gap of context) mark(marks.get(gap.file.replace('.md', '') as keyof ImportFiles)!, gap.offset, gap.offset + gap.text.length)
  }
  return [...gapsFromMarks(files, marks), ...jsonCoverage(plan, files)]
}

export function projectsForDryRun(path: string): Project[] {
  if (!existsSync(path)) throw new Error(`orchestrator database does not exist: ${path}`)
  const readonly = new Database(path, { readonly: true })
  try {
    const rows = readonly.query('SELECT id, name, path, stack, canon, settings FROM project ORDER BY name').all() as {
      id: number; name: string; path: string; stack: string | null; canon: number; settings: string | null
    }[]
    return rows.map((row) => {
      let settings: Project['settings'] = {}
      try { settings = row.settings ? JSON.parse(row.settings) : {} } catch { settings = {} }
      return { ...row, canon: row.canon === 1, settings }
    })
  } finally {
    readonly.close()
  }
}

export class ImportRefusalError extends Error {
  constructor(public refusals: ImportRefusal[]) {
    super(`port import refused with ${refusals.length} refusal(s)`)
  }
}

const GLOBAL_PORT_DOC_SLUGS = [
  'port-doctrine-preface', 'port-stack-mapping', 'port-process-differences',
  'port-differences-unassigned', 'port-category-map', 'port-import-exclusions',
  'port-import-source-context', 'port-ref-metadata', 'port-state-metadata',
]
const PROJECT_PORT_DOC_SLUGS = ['port-differences', 'port-backports']

export function applyImport(plan: ImportPlan, options: { replace?: boolean } = {}): void {
  if (plan.refusals.length) throw new ImportRefusalError(plan.refusals)
  db().transaction(() => {
    const counts = db().query(`SELECT
      (SELECT COUNT(*) FROM port_pair) +
      (SELECT COUNT(*) FROM port_baseline) +
      (SELECT COUNT(*) FROM port_skip) +
      (SELECT COUNT(*) FROM port_ref) +
      (SELECT COUNT(*) FROM port_ref_source) +
      (SELECT COUNT(*) FROM port_doctrine) +
      (SELECT COUNT(*) FROM doc WHERE
        (scope='global' AND subject IS NULL AND slug IN (${GLOBAL_PORT_DOC_SLUGS.map(() => '?').join(',')})) OR
        (scope='project' AND slug IN (${PROJECT_PORT_DOC_SLUGS.map(() => '?').join(',')}))) AS n`)
      .get(...GLOBAL_PORT_DOC_SLUGS, ...PROJECT_PORT_DOC_SLUGS) as { n: number }
    if (counts.n > 0 && !options.replace) {
      throw new ImportRefusalError([{
        kind: 'refusal',
        what: 'existing port data', where: 'orch.db port_* tables or importer-owned docs',
        why: 'the importer requires an empty destination; pass --replace to replace port data and docs',
      }])
    }
    if (options.replace) {
      db().exec('DELETE FROM port_ref_source; DELETE FROM port_ref; DELETE FROM port_skip; DELETE FROM port_baseline; DELETE FROM port_pair; DELETE FROM port_doctrine;')
      const globalPlaceholders = GLOBAL_PORT_DOC_SLUGS.map(() => '?').join(',')
      const projectPlaceholders = PROJECT_PORT_DOC_SLUGS.map(() => '?').join(',')
      db().query(`DELETE FROM doc WHERE
        (scope='global' AND subject IS NULL AND slug IN (${globalPlaceholders})) OR
        (scope='project' AND slug IN (${projectPlaceholders}))`)
        .run(...GLOBAL_PORT_DOC_SLUGS, ...PROJECT_PORT_DOC_SLUGS)
    }

    const pairs = new Map<string, number>()
    for (const row of plan.pairs) pairs.set(`${row.source}->${row.target}`, addPair(row.sourceId, row.targetId).id)
    for (const row of plan.baselines) setBaseline(pairs.get(row.pairKey)!, row.sourceCommit, row.scannedAt)
    for (const row of plan.skips) addSkip(pairs.get(row.pairKey)!, row.candidate, row.reason)
    for (const row of plan.refs) setLedgerRef(row)
    for (const row of plan.doctrine) addDoctrineRule(row.number, row.title, row.body)
    for (const row of plan.docs) setDoc(row)
  })()
}
