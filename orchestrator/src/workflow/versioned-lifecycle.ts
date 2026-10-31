// concern: workflows
/** Shared draft/promote/retire/event mechanics for versioned operator-owned JSON stores. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { workerStoreWriteRefusal } from '../worker-store-write.ts'

type VersionStatus = 'draft' | 'production' | 'retired'
export type VersionEvent = 'set' | 'fork' | 'import' | 'promote' | 'retire'
export type VersionedStoreConfig<T> = {
  noun: string
  identityTable: string
  versionTable: string
  eventTable: string
  foreignKey: string
  validate(value: unknown, d: Database): asserts value is T
}

type Row = {
  record_id: string
  owner_record_id: string
  slug: string
  n: number
  status: VersionStatus
  definition: string
  author: string
  reason: string
  created_at: string
  promoted_at: string | null
  retired_at: string | null
}
type VersionMetadata = Pick<
  Row,
  'n' | 'status' | 'author' | 'reason' | 'created_at' | 'promoted_at' | 'retired_at'
>

const required = (value: string | undefined, name: string) => {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value.trim()
}
const author = (value?: string) => value?.trim() || sessionId() || 'unknown'

function insertOwner(d: Database, table: string, slug: string, at: string): { record_id: string } {
  return d
    .query(
      `INSERT INTO ${table} (record_id,slug,created_at,space_id) VALUES (?,?,?,NULL) RETURNING record_id`,
    )
    .get(newRecordId(), slug, at) as { record_id: string }
}

function assertWorkerStoreWriteAllowed<T>(
  config: VersionedStoreConfig<T>,
  operation: VersionEvent,
) {
  const refusal = workerStoreWriteRefusal('workflow', `${operation} ${config.noun}`, process.env)
  if (refusal) throw new Error(refusal)
}

function validateWrite<T>(
  config: VersionedStoreConfig<T>,
  kind: VersionEvent,
  definition: unknown,
  d: Database,
  validate: VersionedStoreConfig<T>['validate'] = config.validate,
): void {
  assertWorkerStoreWriteAllowed(config, kind)
  validate(definition, d)
}

function ownerId<T>(
  config: VersionedStoreConfig<T>,
  slug: string,
  d: Database,
  spaceId: string | null,
): string {
  const row = (
    d.query(`SELECT record_id,space_id FROM ${config.identityTable} WHERE slug=?`).all(slug) as {
      record_id: string
      space_id: string | null
    }[]
  ).find((candidate) => candidate.space_id === spaceId)
  if (!row)
    throw new Error(
      `unknown ${config.noun} "${slug}"${spaceId === null ? '' : ` in hosted space ${spaceId}`}`,
    )
  return row.record_id
}

const hostedSpaceSuffix = (spaceId: string | null) =>
  spaceId === null ? '' : ` in hosted space ${spaceId}`

function missingVersion<T>(
  config: VersionedStoreConfig<T>,
  slug: string,
  n: number | undefined,
  spaceId: string | null,
): Error {
  return new Error(
    n === undefined
      ? `unknown ${config.noun} "${slug}"${hostedSpaceSuffix(spaceId)}`
      : `${config.noun} "${slug}" has no version ${n}${hostedSpaceSuffix(spaceId)}`,
  )
}

function versionRow<T>(
  config: VersionedStoreConfig<T>,
  slug: string,
  n: number | undefined,
  d: Database,
  spaceId: string | null,
): Row {
  const found = d
    .query(
      `SELECT v.record_id,v.${config.foreignKey} owner_record_id,i.slug,v.n,v.status,v.definition,v.author,v.reason,v.created_at,v.promoted_at,v.retired_at FROM ${config.versionTable} v JOIN ${config.identityTable} i ON i.record_id=v.${config.foreignKey} WHERE i.slug=? AND i.space_id IS ? AND v.superseded_at IS NULL AND (? IS NULL OR v.n=?) ORDER BY CASE status WHEN 'production' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,n DESC LIMIT 1`,
    )
    .get(slug, spaceId, n ?? null, n ?? null) as Row | null
  if (!found) throw missingVersion(config, slug, n, spaceId)
  return found
}

function productionRow<T>(
  config: VersionedStoreConfig<T>,
  slug: string,
  d: Database,
  spaceId: string | null,
): Row {
  const found = d
    .query(
      `SELECT v.record_id,v.${config.foreignKey} owner_record_id,i.slug,v.n,v.status,v.definition,v.author,v.reason,v.created_at,v.promoted_at,v.retired_at FROM ${config.versionTable} v JOIN ${config.identityTable} i ON i.record_id=v.${config.foreignKey} WHERE i.slug=? AND i.space_id IS ? AND v.status='production' AND v.superseded_at IS NULL`,
    )
    .get(slug, spaceId) as Row | null
  if (!found)
    throw new Error(
      `${config.noun} "${slug}" has no production version${hostedSpaceSuffix(spaceId)}; promote one`,
    )
  return found
}

export function versionedLifecycle<T>(config: VersionedStoreConfig<T>) {
  const show = (
    slug: string,
    n: number | undefined,
    d: Database,
    spaceId: string | null = null,
  ) => {
    const found = versionRow(config, slug, n, d, spaceId)
    return { ...found, definition: JSON.parse(found.definition) as T }
  }
  const production = (slug: string, d: Database, spaceId: string | null = null) => {
    const found = productionRow(config, slug, d, spaceId)
    return { ...found, definition: JSON.parse(found.definition) as T }
  }
  const event = (
    d: Database,
    ownerRecordId: string,
    n: number,
    kind: VersionEvent,
    by: string,
    reason: string,
    at: string,
  ) =>
    d
      .query(
        `INSERT INTO ${config.eventTable} (record_id,${config.noun === 'workflow' ? 'workflow_version_record_id' : 'catalogue_version_record_id'},version_n,event,author,reason,session_id,at,space_id) VALUES (?,(SELECT record_id FROM ${config.versionTable} WHERE ${config.foreignKey}=? AND n=? AND superseded_at IS NULL),?,?,?,?,?, ?,NULL)`,
      )
      .run(newRecordId(), ownerRecordId, n, n, kind, by, reason, sessionId(), at)

  const write = (
    slug: string,
    definition: unknown,
    reasonValue: string | undefined,
    authorValue: string | undefined,
    kind: Extract<VersionEvent, 'set' | 'fork' | 'import'>,
    d: Database,
    validate: VersionedStoreConfig<T>['validate'] = config.validate,
  ) => {
    validateWrite(config, kind, definition, d, validate)
    const why = required(reasonValue, 'reason'),
      by = author(authorValue),
      at = nowIso()
    return writeTransaction(() => {
      let identity = d
        .query(`SELECT record_id FROM ${config.identityTable} WHERE slug=? AND space_id IS NULL`)
        .get(slug) as {
        record_id: string
      } | null
      if (!identity) identity = insertOwner(d, config.identityTable, slug, at)
      const max = d
        .query(
          `SELECT COALESCE(MAX(n),0) n FROM ${config.versionTable} WHERE ${config.foreignKey}=? AND superseded_at IS NULL`,
        )
        .get(identity.record_id) as { n: number }
      const n = max.n + 1
      d.query(
        `INSERT INTO ${config.versionTable} (record_id,${config.foreignKey},n,status,definition,author,reason,created_at,space_id) VALUES (?,?,?,'draft',?,?,?,?,NULL)`,
      ).run(newRecordId(), identity.record_id, n, JSON.stringify(definition), by, why, at)
      event(d, identity.record_id, n, kind, by, why, at)
      return show(slug, n, d)
    }, d)
  }
  const promote = (
    slug: string,
    n: number,
    reasonValue: string | undefined,
    authorValue: string | undefined,
    d: Database,
    preflight?: (definition: T, d: Database) => void,
  ) => {
    assertWorkerStoreWriteAllowed(config, 'promote')
    const why = required(reasonValue, 'reason'),
      by = author(authorValue),
      at = nowIso(),
      id = ownerId(config, slug, d, null)
    return writeTransaction(() => {
      const target = show(slug, n, d)
      if (target.status !== 'draft')
        throw new Error(`${config.noun} "${slug}" version ${n} is not a draft`)
      config.validate(target.definition, d)
      preflight?.(target.definition, d)
      const prior = d
        .query(
          `SELECT n FROM ${config.versionTable} WHERE ${config.foreignKey}=? AND status='production' AND superseded_at IS NULL`,
        )
        .get(id) as { n: number } | null
      d.query(
        `UPDATE ${config.versionTable} SET status='retired',retired_at=? WHERE ${config.foreignKey}=? AND status='production' AND superseded_at IS NULL`,
      ).run(at, id)
      if (prior) event(d, id, prior.n, 'retire', by, why, at)
      d.query(
        `UPDATE ${config.versionTable} SET status='production',promoted_at=? WHERE ${config.foreignKey}=? AND n=? AND superseded_at IS NULL`,
      ).run(at, id, n)
      event(d, id, n, 'promote', by, why, at)
      return show(slug, n, d)
    }, d)
  }
  const retire = (
    slug: string,
    n: number,
    reasonValue: string | undefined,
    authorValue: string | undefined,
    d: Database,
  ) => {
    assertWorkerStoreWriteAllowed(config, 'retire')
    const why = required(reasonValue, 'reason'),
      by = author(authorValue),
      at = nowIso(),
      id = ownerId(config, slug, d, null)
    return writeTransaction(() => {
      const target = show(slug, n, d)
      if (target.status === 'retired')
        throw new Error(`${config.noun} "${slug}" version ${n} is retired`)
      d.query(
        `UPDATE ${config.versionTable} SET status='retired',retired_at=? WHERE ${config.foreignKey}=? AND n=? AND superseded_at IS NULL`,
      ).run(at, id, n)
      event(d, id, n, 'retire', by, why, at)
      return show(slug, n, d)
    }, d)
  }
  const versions = (slug: string, d: Database, spaceId: string | null) => {
    const id = ownerId(config, slug, d, spaceId)
    const rows = d
      .query(
        `SELECT n,status,author,reason,created_at,promoted_at,retired_at FROM ${config.versionTable} WHERE ${config.foreignKey}=? AND superseded_at IS NULL ORDER BY n`,
      )
      .all(id) as VersionMetadata[]
    return rows.map((version) => ({
      ...version,
      events: d
        .query(
          `SELECT e.event,e.author,e.reason,e.session_id,e.at FROM ${config.eventTable} e JOIN ${config.versionTable} v ON v.record_id=e.${config.noun === 'workflow' ? 'workflow_version_record_id' : 'catalogue_version_record_id'} WHERE v.${config.foreignKey}=? AND v.superseded_at IS NULL AND e.version_n=? ORDER BY e.rowid`,
        )
        .all(id, version.n as number),
    }))
  }
  return { show, production, write, promote, retire, versions }
}
