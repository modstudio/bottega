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
  corpusKey: string
  project: string | null
  repositoryPath: string | null
  startLine: number | null
  endLine: number | null
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
  corpusKey: string
  project?: string
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
          corpus_key TEXT NOT NULL DEFAULT 'docs',
          project TEXT,
          repository_path TEXT,
          start_line INTEGER,
          end_line INTEGER,
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
      const columns = new Set(
        database
          .query<{ name: string }, []>('PRAGMA table_info(document_vector)')
          .all()
          .map((row) => row.name),
      )
      for (const [name, declaration] of [
        ['corpus_key', "TEXT NOT NULL DEFAULT 'docs'"],
        ['project', 'TEXT'],
        ['repository_path', 'TEXT'],
        ['start_line', 'INTEGER'],
        ['end_line', 'INTEGER'],
      ] as const) {
        if (!columns.has(name))
          database.exec(`ALTER TABLE document_vector ADD COLUMN ${name} ${declaration}`)
      }
    })
    .immediate()
}

export function openIndexDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const database = new Database(path, { create: true })
  configureIndexDatabase(database)
  return database
}

export function storedRows(database: Database, corpusKey = 'docs'): StoredVectorRow[] {
  return database
    .query<
      {
        chunk_id: string
        content_hash: string
        model: string
        dimension: number
        instruction_version: string
      },
      [string]
    >(
      'SELECT chunk_id, content_hash, model, dimension, instruction_version FROM document_vector WHERE corpus_key = ?',
    )
    .all(corpusKey)
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
      corpus_key, project, repository_path, start_line, end_line,
      scope, subject, slug, title, heading_path, text, document, vector
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      content_hash=excluded.content_hash, model=excluded.model,
      dimension=excluded.dimension, instruction_version=excluded.instruction_version,
      corpus_key=excluded.corpus_key, project=excluded.project,
      repository_path=excluded.repository_path, start_line=excluded.start_line,
      end_line=excluded.end_line,
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
        const doc = identity.kind === 'doc' ? identity : null
        upsert.run(
          candidate.chunk.id,
          candidate.contentHash,
          EMBEDDING_MODEL,
          EMBEDDING_DIMENSION,
          INSTRUCTION_VERSION,
          prepared.corpusKey,
          prepared.project ?? null,
          identity.kind === 'code' ? identity.path : null,
          identity.kind === 'code' ? candidate.chunk.startLine : null,
          identity.kind === 'code' ? candidate.chunk.endLine : null,
          doc?.scope ?? '',
          doc?.subject ?? null,
          doc?.slug ?? '',
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

export function indexedRows(database: Database, corpusKey = 'docs'): IndexedRow[] {
  return database
    .query<Record<string, unknown>, [string]>(
      'SELECT * FROM document_vector WHERE corpus_key = ? ORDER BY chunk_id',
    )
    .all(corpusKey)
    .map((row) => ({
      chunkId: String(row.chunk_id),
      contentHash: String(row.content_hash),
      model: String(row.model),
      dimension: Number(row.dimension),
      instructionVersion: String(row.instruction_version),
      corpusKey: String(row.corpus_key),
      project: row.project === null ? null : String(row.project),
      repositoryPath: row.repository_path === null ? null : String(row.repository_path),
      startLine: row.start_line === null ? null : Number(row.start_line),
      endLine: row.end_line === null ? null : Number(row.end_line),
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
