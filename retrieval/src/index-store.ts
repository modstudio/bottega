// concern: retrieval-index-store
/** Owns the SQLite document-vector schema and transactions. */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL, INSTRUCTION_VERSION } from './contract.ts'
import type {
  PlannedDelete,
  PlannedUpsert,
  StoredVectorIdentity,
  StoredVectorRow,
} from './refresh-plan.ts'

const RETRIEVAL_BUSY_TIMEOUT_MS = 15_000

type IndexedRow = StoredVectorRow & {
  scope: string
  subject: string | null
  slug: string
  title: string
  headingPath: string
  text: string
  document: string
  vector: Uint8Array
}

type VectorUpsert = PlannedUpsert & {
  document: string
  vector: number[]
}

export type PreparedRefresh = {
  delete: PlannedDelete[]
  upsert: VectorUpsert[]
}

export type AppliedRefresh = {
  embedded: number
  deleted: number
  stale: number
}

export function configureIndexDatabase(database: Database): void {
  database.exec(`PRAGMA busy_timeout = ${RETRIEVAL_BUSY_TIMEOUT_MS}`)
  database.exec('PRAGMA journal_mode = WAL')
  database
    .transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS document_vector (
          chunk_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          model TEXT NOT NULL,
          dimension INTEGER NOT NULL,
          instruction_version TEXT NOT NULL,
          scope TEXT NOT NULL,
          subject TEXT,
          slug TEXT NOT NULL,
          title TEXT NOT NULL,
          heading_path TEXT NOT NULL,
          text TEXT NOT NULL,
          document TEXT NOT NULL,
          vector BLOB NOT NULL
        )
      `)
    })
    .immediate()
}

export function openIndexDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const database = new Database(path, { create: true })
  configureIndexDatabase(database)
  return database
}

export function storedRows(database: Database): StoredVectorRow[] {
  return database
    .query<
      {
        chunk_id: string
        content_hash: string
        model: string
        dimension: number
        instruction_version: string
      },
      []
    >('SELECT chunk_id, content_hash, model, dimension, instruction_version FROM document_vector')
    .all()
    .map((row) => ({
      chunkId: row.chunk_id,
      contentHash: row.content_hash,
      model: row.model,
      dimension: row.dimension,
      instructionVersion: row.instruction_version,
    }))
}

function vectorBlob(vector: number[]): Uint8Array {
  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `embedding endpoint returned dimension ${vector.length}; expected ${EMBEDDING_DIMENSION}`,
    )
  }
  return new Uint8Array(new Float32Array(vector).buffer)
}

export function applyRefresh(database: Database, prepared: PreparedRefresh): AppliedRefresh {
  const upsert = database.query(`
    INSERT INTO document_vector (
      chunk_id, content_hash, model, dimension, instruction_version,
      scope, subject, slug, title, heading_path, text, document, vector
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      content_hash=excluded.content_hash, model=excluded.model,
      dimension=excluded.dimension, instruction_version=excluded.instruction_version,
      scope=excluded.scope, subject=excluded.subject, slug=excluded.slug,
      title=excluded.title, heading_path=excluded.heading_path, text=excluded.text,
      document=excluded.document, vector=excluded.vector
  `)
  const remove = database.query('DELETE FROM document_vector WHERE chunk_id = ?')
  const currentIdentity = database.query<
    {
      content_hash: string
      model: string
      dimension: number
      instruction_version: string
    },
    [string]
  >(
    `SELECT content_hash, model, dimension, instruction_version
       FROM document_vector WHERE chunk_id = ?`,
  )
  const observedIdentity = (chunkId: string): StoredVectorIdentity | null => {
    const row = currentIdentity.get(chunkId)
    return row
      ? {
          contentHash: row.content_hash,
          model: row.model,
          dimension: row.dimension,
          instructionVersion: row.instruction_version,
        }
      : null
  }
  const sameIdentity = (
    left: StoredVectorIdentity | null,
    right: StoredVectorIdentity | null,
  ): boolean =>
    left?.contentHash === right?.contentHash &&
    left?.model === right?.model &&
    left?.dimension === right?.dimension &&
    left?.instructionVersion === right?.instructionVersion
  return database
    .transaction(() => {
      const counts: AppliedRefresh = { embedded: 0, deleted: 0, stale: 0 }
      for (const candidate of prepared.delete) {
        if (!sameIdentity(observedIdentity(candidate.chunkId), candidate.observed)) {
          counts.stale++
          continue
        }
        remove.run(candidate.chunkId)
        counts.deleted++
      }
      for (const candidate of prepared.upsert) {
        if (!sameIdentity(observedIdentity(candidate.chunk.id), candidate.observed)) {
          counts.stale++
          continue
        }
        const identity = candidate.chunk.identity
        if (identity.kind !== 'doc') throw new Error('retrieval index accepts document chunks only')
        upsert.run(
          candidate.chunk.id,
          candidate.contentHash,
          EMBEDDING_MODEL,
          EMBEDDING_DIMENSION,
          INSTRUCTION_VERSION,
          identity.scope,
          identity.subject,
          identity.slug,
          candidate.chunk.docTitle ?? '',
          JSON.stringify(candidate.chunk.headingPath ?? []),
          candidate.chunk.text,
          candidate.document,
          vectorBlob(candidate.vector),
        )
        counts.embedded++
      }
      return counts
    })
    .immediate()
}

export function indexedRows(database: Database): IndexedRow[] {
  return database
    .query<Record<string, unknown>, []>('SELECT * FROM document_vector ORDER BY chunk_id')
    .all()
    .map((row) => ({
      chunkId: String(row.chunk_id),
      contentHash: String(row.content_hash),
      model: String(row.model),
      dimension: Number(row.dimension),
      instructionVersion: String(row.instruction_version),
      scope: String(row.scope),
      subject: row.subject === null ? null : String(row.subject),
      slug: String(row.slug),
      title: String(row.title),
      headingPath: String(row.heading_path),
      text: String(row.text),
      document: String(row.document),
      vector: row.vector as Uint8Array,
    }))
}
