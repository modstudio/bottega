// concern: gate facts
/** The branch-stable store facts consumed by machine-dependent gate legs. */
import type { Database } from 'bun:sqlite'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FROZEN_ENV_NAMES } from '../../../shared/brand.ts'
import { DOC_SCOPES, type DocScope } from '../../../shared/docs.ts'
import { db } from '../database/db.ts'
import { isDocInjectedForRun } from '../doc/doc-injection.ts'
import { listDocsStore } from '../doc/doc-read-store.ts'
import { type Project, projectAmong, projects } from '../project/projects.ts'
import { assertGateFactsFormat, GATE_FACTS_FORMAT_VERSION } from './gate-facts-contract.ts'

export const GATE_FACTS_ENV = FROZEN_ENV_NAMES.gateFacts

type GateFactDoc = {
  recordId: string
  revisionId: string
  scope: DocScope
  subject: string | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
}

export type GateFacts = {
  formatVersion: typeof GATE_FACTS_FORMAT_VERSION
  migrationVersion: number
  projects: Project[]
  docs: GateFactDoc[]
}

function migrationVersion(database: Database): number {
  return (database.query('PRAGMA user_version').get() as { user_version: number }).user_version
}

export function collectGateFacts(database: Database = db()): GateFacts {
  const activeProjects = projects(undefined, database)
  const projectNames = new Set(activeProjects.map(({ name }) => name))
  const docs = listDocsStore({ status: 'current' }, database)
    .filter(
      (doc) =>
        (doc.scope === 'canon' && (doc.subject === null || projectNames.has(doc.subject))) ||
        isDocInjectedForRun(doc, doc.scope === 'job' ? (doc.subject ?? '') : '', null) ||
        [...projectNames].some((projectName) => isDocInjectedForRun(doc, '', projectName)),
    )
    .map((doc) => {
      if (!doc.revision) {
        throw new Error(
          `doc ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} has no revision; refusing gate facts`,
        )
      }
      return {
        recordId: doc.record_id,
        revisionId: doc.revision,
        scope: doc.scope,
        subject: doc.subject,
        slug: doc.slug,
        title: doc.title,
        body: doc.body,
        delivery: doc.delivery,
      }
    })
  return {
    formatVersion: GATE_FACTS_FORMAT_VERSION,
    migrationVersion: migrationVersion(database),
    projects: activeProjects,
    docs,
  }
}

export function writeGateFacts(path: string, database: Database = db()): void {
  const temporary = join(dirname(path), `.gate-facts-${process.pid}.json`)
  writeFileSync(temporary, `${JSON.stringify(collectGateFacts(database))}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function isProject(value: unknown): value is Project {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.recordId === 'string' &&
    typeof row.name === 'string' &&
    typeof row.path === 'string' &&
    (typeof row.stack === 'string' || row.stack === null) &&
    typeof row.canon === 'boolean' &&
    (typeof row.retiredAt === 'string' || row.retiredAt === null) &&
    typeof row.settings === 'object' &&
    row.settings !== null &&
    !Array.isArray(row.settings)
  )
}

function isGateFactDoc(value: unknown): value is GateFactDoc {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.recordId === 'string' &&
    typeof row.revisionId === 'string' &&
    typeof row.scope === 'string' &&
    DOC_SCOPES.includes(row.scope as DocScope) &&
    (typeof row.subject === 'string' || row.subject === null) &&
    typeof row.slug === 'string' &&
    typeof row.title === 'string' &&
    typeof row.body === 'string' &&
    (row.delivery === 'inject' || row.delivery === 'demand')
  )
}

export function parseGateFacts(text: string): GateFacts {
  assertGateFactsFormat(text)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error(`gate facts are not valid JSON: ${String((cause as Error).message ?? cause)}`)
  }
  if (typeof value !== 'object' || value === null) throw new Error('gate facts must be an object')
  const facts = value as Record<string, unknown>
  if (
    !Number.isInteger(facts.migrationVersion) ||
    !Array.isArray(facts.projects) ||
    !facts.projects.every(isProject) ||
    !Array.isArray(facts.docs) ||
    !facts.docs.every(isGateFactDoc)
  ) {
    throw new Error('gate facts do not match the declared format')
  }
  return facts as GateFacts
}

export function readGateFactsFile(path: string): GateFacts {
  return parseGateFacts(readFileSync(path, 'utf8'))
}

export function projectAtGateFacts(cwd: string, facts: GateFacts): Project | null {
  return projectAmong(cwd, facts.projects)
}
