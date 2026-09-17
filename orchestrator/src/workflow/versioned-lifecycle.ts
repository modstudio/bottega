// concern: workflows
/** Shared draft/promote/retire/event mechanics for versioned operator-owned JSON stores. */
import type { Database } from 'bun:sqlite'
import { nowIso, sessionId, writeTransaction } from '../database/db.ts'

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
  id: number
  owner_id: number
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

export function versionedLifecycle<T>(config: VersionedStoreConfig<T>) {
  const ownerId = (slug: string, d: Database) => {
    const row = d.query(`SELECT id FROM ${config.identityTable} WHERE slug=?`).get(slug) as {
      id: number
    } | null
    if (!row) throw new Error(`unknown ${config.noun} "${slug}"`)
    return row.id
  }
  const row = (slug: string, n: number | undefined, d: Database): Row => {
    const suffix =
      n === undefined
        ? `ORDER BY CASE status WHEN 'production' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, n DESC LIMIT 1`
        : `AND v.n=?`
    const found = d
      .query(
        `SELECT v.*,v.${config.foreignKey} owner_id,i.slug FROM ${config.versionTable} v JOIN ${config.identityTable} i ON i.id=v.${config.foreignKey} WHERE i.slug=? ${suffix}`,
      )
      .get(...(n === undefined ? [slug] : [slug, n])) as Row | null
    if (!found)
      throw new Error(
        n === undefined
          ? `unknown ${config.noun} "${slug}"`
          : `${config.noun} "${slug}" has no version ${n}`,
      )
    return found
  }
  const show = (slug: string, n: number | undefined, d: Database) => {
    const found = row(slug, n, d)
    return { ...found, definition: JSON.parse(found.definition) as T }
  }
  const production = (slug: string, d: Database) => {
    const found = d
      .query(
        `SELECT v.*,v.${config.foreignKey} owner_id,i.slug FROM ${config.versionTable} v JOIN ${config.identityTable} i ON i.id=v.${config.foreignKey} WHERE i.slug=? AND v.status='production'`,
      )
      .get(slug) as Row | null
    if (!found) throw new Error(`${config.noun} "${slug}" has no production version; promote one`)
    return { ...found, definition: JSON.parse(found.definition) as T }
  }
  const event = (
    d: Database,
    id: number,
    n: number,
    kind: VersionEvent,
    by: string,
    reason: string,
    at: string,
  ) =>
    d
      .query(
        `INSERT INTO ${config.eventTable} (${config.foreignKey},version_n,event,author,reason,session_id,at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, n, kind, by, reason, sessionId(), at)

  const write = (
    slug: string,
    definition: unknown,
    reasonValue: string | undefined,
    authorValue: string | undefined,
    kind: Extract<VersionEvent, 'set' | 'fork' | 'import'>,
    d: Database,
  ) => {
    config.validate(definition, d)
    const why = required(reasonValue, 'reason'),
      by = author(authorValue),
      at = nowIso()
    return writeTransaction(() => {
      let identity = d.query(`SELECT id FROM ${config.identityTable} WHERE slug=?`).get(slug) as {
        id: number
      } | null
      if (!identity)
        identity = d
          .query(`INSERT INTO ${config.identityTable} (slug,created_at) VALUES (?,?) RETURNING id`)
          .get(slug, at) as { id: number }
      const max = d
        .query(
          `SELECT COALESCE(MAX(n),0) n FROM ${config.versionTable} WHERE ${config.foreignKey}=?`,
        )
        .get(identity.id) as { n: number }
      const n = max.n + 1
      d.query(
        `INSERT INTO ${config.versionTable} (${config.foreignKey},n,status,definition,author,reason,created_at) VALUES (?,?,'draft',?,?,?,?)`,
      ).run(identity.id, n, JSON.stringify(definition), by, why, at)
      event(d, identity.id, n, kind, by, why, at)
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
    const why = required(reasonValue, 'reason'),
      by = author(authorValue),
      at = nowIso(),
      id = ownerId(slug, d)
    return writeTransaction(() => {
      const target = show(slug, n, d)
      if (target.status !== 'draft')
        throw new Error(`${config.noun} "${slug}" version ${n} is not a draft`)
      preflight?.(target.definition, d)
      const prior = d
        .query(
          `SELECT n FROM ${config.versionTable} WHERE ${config.foreignKey}=? AND status='production'`,
        )
        .get(id) as { n: number } | null
      d.query(
        `UPDATE ${config.versionTable} SET status='retired',retired_at=? WHERE ${config.foreignKey}=? AND status='production'`,
      ).run(at, id)
      if (prior) event(d, id, prior.n, 'retire', by, why, at)
      d.query(
        `UPDATE ${config.versionTable} SET status='production',promoted_at=? WHERE ${config.foreignKey}=? AND n=?`,
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
    const why = required(reasonValue, 'reason'),
      by = author(authorValue),
      at = nowIso(),
      id = ownerId(slug, d)
    return writeTransaction(() => {
      const target = show(slug, n, d)
      if (target.status !== 'production')
        throw new Error(`${config.noun} "${slug}" version ${n} is not production`)
      d.query(
        `UPDATE ${config.versionTable} SET status='retired',retired_at=? WHERE ${config.foreignKey}=? AND n=?`,
      ).run(at, id, n)
      event(d, id, n, 'retire', by, why, at)
      return show(slug, n, d)
    }, d)
  }
  const versions = (slug: string, d: Database) => {
    const id = ownerId(slug, d)
    const rows = d
      .query(
        `SELECT n,status,author,reason,created_at,promoted_at,retired_at FROM ${config.versionTable} WHERE ${config.foreignKey}=? ORDER BY n`,
      )
      .all(id) as VersionMetadata[]
    return rows.map((version) => ({
      ...version,
      events: d
        .query(
          `SELECT event,author,reason,session_id,at FROM ${config.eventTable} WHERE ${config.foreignKey}=? AND version_n=? ORDER BY id`,
        )
        .all(id, version.n as number),
    }))
  }
  return { show, production, write, promote, retire, versions }
}
