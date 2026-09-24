import { newRecordId } from '../../../shared/record/schema.ts'
import {
  consumeDocBody,
  decideDocRevisionWrite,
  refuseDocWrite,
} from '../../src/doc/doc-write-allowed.ts'
import type {
  RecordApiClient,
  RecordDocImportInput,
  RecordDocUpsertInput,
} from '../../src/record/record-api-client.ts'

type StoredDoc = {
  id: string
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  projectName: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

type StoredRevision = {
  id: string
  docId: string
  scope: string
  subject: string | null
  slug: string
  op: string
  title: string
  body: string
  delivery: string
  author: string
  reason: string
  at: string
}

const INJECT_KEY = Symbol.for('orch.record-api-client')

export function installRecordApiClient(client: RecordApiClient | null): void {
  const holder = globalThis as typeof globalThis & {
    [INJECT_KEY]?: { current: RecordApiClient | null }
  }
  const existing = holder[INJECT_KEY]
  if (existing) {
    existing.current = client
    return
  }
  holder[INJECT_KEY] = { current: client }
}

export function createMemoryRecordApiClient(): RecordApiClient {
  const docs = new Map<string, StoredDoc>()
  const revisions = new Map<string, StoredRevision[]>()
  const scores = new Map<string, Record<string, unknown>>()
  const voids = new Map<string, string>()

  const live = (scope: string, subject: string | null, slug: string) =>
    [...docs.values()].find(
      (doc) =>
        doc.scope === scope &&
        doc.subject === subject &&
        doc.slug === slug &&
        doc.deletedAt === null,
    )

  return {
    async whoami() {
      return {
        user: {
          id: '01990000-0000-7000-8000-000000000001',
          name: 'Fixture',
          email: 'fixture@example.test',
        },
        activeSpaceId: '01990000-0000-7000-8000-000000000002',
        personalSpaceId: '01990000-0000-7000-8000-000000000002',
        memberships: [],
      }
    },
    async inviteMember() {
      return { id: newRecordId() }
    },
    async putSnapshot() {
      return { takenAt: new Date().toISOString() }
    },
    async listSnapshots() {
      return { items: [] }
    },
    async listDocs(query) {
      const items = [...docs.values()].filter((doc) => {
        if (query.scope && doc.scope !== query.scope) return false
        if (query.subject !== undefined && doc.subject !== query.subject) return false
        if (!query.includeDeleted && doc.deletedAt) return false
        if (query.updatedSince && doc.updatedAt <= query.updatedSince) return false
        return true
      })
      return { items, nextCursor: null }
    },
    async getDoc(id) {
      const doc = docs.get(id)
      if (!doc) throw new Error('doc not found')
      return doc
    },
    async listRevisions(id) {
      return revisions.get(id) ?? []
    },
    async upsertDoc(input: RecordDocUpsertInput) {
      const refusal = refuseDocWrite({
        scope: input.scope,
        subject: input.subject,
        slug: input.slug,
        body: input.body,
        delivery: input.delivery,
        forceInject: input.forceInject,
        packBytes: 0,
        globalCanonSlugs: [...docs.values()]
          .filter((doc) => doc.scope === 'canon' && doc.subject === null && !doc.deletedAt)
          .map((doc) => doc.slug),
        projectCanonSlugs: [...docs.values()]
          .filter(
            (doc) =>
              doc.scope === 'canon' &&
              doc.subject !== null &&
              doc.subject === input.subject &&
              !doc.deletedAt,
          )
          .map((doc) => doc.slug),
        currentCanon: [],
        nextCanon: [{ slug: input.slug, body: input.body }],
        allowCanonBootstrap: true,
      })
      if (refusal) throw new Error(refusal)
      const now = input.at ?? new Date().toISOString()
      const existing = live(input.scope, input.subject, input.slug)
      const current = existing ? (revisions.get(existing.id)?.at(-1)?.id ?? null) : null
      const revisionDecision = decideDocRevisionWrite({
        expected: input.expectedRevision,
        current,
        isCreate: !existing,
        scope: input.scope,
      })
      if (!revisionDecision.allow) throw new Error(revisionDecision.reason)
      const id = existing?.id ?? input.id ?? newRecordId()
      const revisionId = input.revisionId ?? newRecordId()
      docs.set(id, {
        id,
        scope: input.scope,
        subject: input.subject,
        slug: input.slug,
        title: input.title,
        body: input.body,
        delivery: input.delivery,
        projectName: input.projectName ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
      })
      const list = revisions.get(id) ?? []
      list.push({
        id: revisionId,
        docId: id,
        scope: input.scope,
        subject: input.subject,
        slug: input.slug,
        op: input.op ?? (existing ? 'set' : 'create'),
        title: input.title,
        body: input.body,
        delivery: input.delivery,
        author: input.author,
        reason: input.reason,
        at: now,
      })
      revisions.set(id, list)
      return { id, revisionId }
    },
    async importDoc(input: RecordDocImportInput) {
      const atAddress = [...docs.values()].filter(
        (doc) =>
          doc.scope === input.doc.scope &&
          doc.subject === input.doc.subject &&
          doc.slug === input.doc.slug,
      )
      const liveDoc = atAddress.find((doc) => doc.deletedAt === null)
      if (liveDoc && liveDoc.body !== input.doc.body && liveDoc.updatedAt > input.doc.updatedAt) {
        throw new Error(
          `refusing import: hosted doc at ${input.doc.scope}/${input.doc.subject ?? ''}/${input.doc.slug} has a different body and newer updated_at`,
        )
      }
      const existing =
        liveDoc ??
        [...atAddress].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
      const current = existing ? (revisions.get(existing.id)?.at(-1)?.id ?? null) : null
      const decision = decideDocRevisionWrite({
        expected: input.expectedRevision,
        current,
        isCreate: !existing,
        scope: input.doc.scope,
      })
      if (!decision.allow) throw new Error(decision.reason)
      const id = existing?.id ?? newRecordId()
      docs.set(id, {
        id,
        scope: input.doc.scope,
        subject: input.doc.subject,
        slug: input.doc.slug,
        title: input.doc.title,
        body: input.doc.body,
        delivery: input.doc.delivery,
        projectName: input.doc.projectName ?? null,
        createdAt: input.doc.createdAt,
        updatedAt: input.doc.updatedAt,
        deletedAt: input.doc.deletedAt,
      })
      const list = revisions.get(id) ?? []
      const revisionIds: string[] = []
      for (const revision of input.revisions) {
        const found = list.find(
          (row) =>
            row.at === revision.at &&
            row.op === revision.op &&
            row.author === revision.author &&
            row.reason === revision.reason,
        )
        if (found) {
          revisionIds.push(found.id)
          continue
        }
        const revisionId = newRecordId()
        list.push({
          id: revisionId,
          docId: id,
          scope: revision.scope,
          subject: revision.subject,
          slug: revision.slug,
          op: revision.op,
          title: revision.title,
          body: revision.body,
          delivery: revision.delivery,
          author: revision.author,
          reason: revision.reason,
          at: revision.at,
        })
        revisionIds.push(revisionId)
      }
      revisions.set(id, list)
      return { id, revisionIds }
    },
    async deleteDoc(id, input) {
      const doc = docs.get(id)
      if (!doc) throw new Error('doc not found')
      const decision = decideDocRevisionWrite({
        expected: input.expectedRevision,
        current: revisions.get(id)?.at(-1)?.id ?? null,
        isCreate: false,
        scope: doc.scope,
      })
      if (!decision.allow) throw new Error(decision.reason)
      const now = new Date().toISOString()
      const revisionId = newRecordId()
      docs.set(id, { ...doc, deletedAt: now, updatedAt: now })
      const list = revisions.get(id) ?? []
      list.push({
        id: revisionId,
        docId: id,
        scope: doc.scope,
        subject: doc.subject,
        slug: doc.slug,
        op: 'delete',
        title: doc.title,
        body: doc.body,
        delivery: doc.delivery,
        author: input.author,
        reason: input.reason,
        at: now,
      })
      revisions.set(id, list)
      return { id, revisionId }
    },
    async consumeDoc(id, input) {
      const doc = docs.get(id)
      if (!doc || doc.deletedAt) throw new Error('doc not found')
      const decision = decideDocRevisionWrite({
        expected: input.expectedRevision,
        current: revisions.get(id)?.at(-1)?.id ?? null,
        isCreate: false,
        scope: doc.scope,
      })
      if (!decision.allow) throw new Error(decision.reason)
      const now = new Date().toISOString()
      const consumed = consumeDocBody(doc.body, now, input.author)
      if (consumed.alreadyConsumed) return { id, revisionId: '', alreadyConsumed: true }
      const revisionId = newRecordId()
      docs.set(id, { ...doc, body: consumed.body, updatedAt: now })
      const list = revisions.get(id) ?? []
      list.push({
        id: revisionId,
        docId: id,
        scope: doc.scope,
        subject: doc.subject,
        slug: doc.slug,
        op: 'consume',
        title: doc.title,
        body: consumed.body,
        delivery: doc.delivery,
        author: input.author,
        reason: input.reason,
        at: now,
      })
      revisions.set(id, list)
      return { id, revisionId, alreadyConsumed: false }
    },
    async restoreDoc(id, input) {
      const doc = docs.get(id)
      const list = revisions.get(id) ?? []
      const revision = list.find((row) => row.id === input.revisionId) ?? list.at(-1)
      if (!doc && !revision) throw new Error('revision not found')
      const decision = decideDocRevisionWrite({
        expected: input.expectedRevision,
        current: list.at(-1)?.id ?? null,
        isCreate: false,
        scope: doc?.scope ?? revision!.scope,
      })
      if (!decision.allow) throw new Error(decision.reason)
      const source = revision ?? {
        title: doc!.title,
        body: doc!.body,
        delivery: doc!.delivery,
        scope: doc!.scope,
        subject: doc!.subject,
        slug: doc!.slug,
      }
      const now = new Date().toISOString()
      const revisionId = newRecordId()
      const restored: StoredDoc = {
        id,
        scope: source.scope,
        subject: source.subject,
        slug: source.slug,
        title: source.title,
        body: source.body,
        delivery: source.delivery as 'inject' | 'demand',
        projectName: doc?.projectName ?? null,
        createdAt: doc?.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
      }
      docs.set(id, restored)
      list.push({
        id: revisionId,
        docId: id,
        scope: restored.scope,
        subject: restored.subject,
        slug: restored.slug,
        op: 'restore',
        title: restored.title,
        body: restored.body,
        delivery: restored.delivery,
        author: input.author,
        reason: input.reason,
        at: now,
      })
      revisions.set(id, list)
      return { id, revisionId }
    },
    async upsertProject(input) {
      return { name: input.name }
    },
    async retireProject(name) {
      return { name }
    },
    async renameSubject(input) {
      const matchingDocs = [...docs.values()].filter((doc) => doc.subject === input.from)
      const matchingRevisions = [...revisions.values()]
        .flat()
        .filter((row) => row.subject === input.from)
      if (matchingDocs.length + matchingRevisions.length !== input.count) {
        throw new Error(
          `refusing subject rename: hosted count ${matchingDocs.length + matchingRevisions.length} does not match stated ${input.count}`,
        )
      }
      for (const doc of matchingDocs) {
        docs.set(doc.id, { ...doc, subject: input.to, updatedAt: new Date().toISOString() })
      }
      for (const [docId, list] of revisions) {
        revisions.set(
          docId,
          list.map((row) => (row.subject === input.from ? { ...row, subject: input.to } : row)),
        )
      }
      return { docs: matchingDocs.length, revisions: matchingRevisions.length }
    },
    async putScore(runId, input) {
      scores.set(runId, input)
    },
    async voidRun(runId, input) {
      voids.set(runId, input.reason)
    },
    async unvoidRun(runId) {
      voids.delete(runId)
    },
    async listScores() {
      const items = [
        ...[...scores.entries()].map(([runId, score]) => ({ runId, ...score })),
        ...[...voids.entries()].map(([runId, evidenceExcluded]) => ({ runId, evidenceExcluded })),
      ]
      return { items, nextCursor: null }
    },
    async counts() {
      return {
        docs: docs.size,
        revisions: [...revisions.values()].reduce((sum, list) => sum + list.length, 0),
        scores: scores.size,
        voids: voids.size,
      }
    },
  }
}
