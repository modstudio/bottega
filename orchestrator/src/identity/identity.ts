// concern: record-identity
/** Resolves parsed references through the authority and ownership rules for their kind. */

import type { Database } from 'bun:sqlite'
import {
  IDENTITY_STATE_CLASSES,
  type IdentityAuthority,
} from '../../../shared/identity-state-classes.ts'
import { parseReference, type ReferenceKind } from '../../../shared/reference.ts'
import { projectByName, projectByRecordId } from '../project/project-read.ts'
import { effectiveProjectSpace } from '../project-space.ts'
import { questionById, questionByProjectNumber } from '../question-store/question-store-read.ts'

type ResolvableKind = Exclude<ReferenceKind, 'task'>

export const IDENTITY_KINDS = {
  question: {
    table: IDENTITY_STATE_CLASSES.question.table,
    prefix: 'q',
    numberScope: 'space',
    authority: IDENTITY_STATE_CLASSES.question.class,
    ownerChain: 'question → run or cursor',
  },
  run: {
    table: IDENTITY_STATE_CLASSES.run.table,
    prefix: 'r',
    numberScope: 'machine',
    authority: IDENTITY_STATE_CLASSES.run.class,
    ownerChain: 'run → task → project',
  },
} as const

export type ResolvedIdentity = {
  kind: ResolvableKind
  recordId: string
  projectId: string | null
  spaceId: string | null
  authority: IdentityAuthority
}

export type IdentityContext = {
  database: Database
  sessionId: string | null
  projectId: string | null
  projectName: string | null
  identityMap: Map<string, ResolvedIdentity>
}

type IdentityRow = { record_id: string; project_record_id: string | null }

const projectSpace = (context: IdentityContext, projectId: string | null): string | null => {
  const project = projectId ? projectByRecordId(projectId, context.database) : null
  return effectiveProjectSpace(context.database, project?.name ?? null)
}

function runById(context: IdentityContext, recordId: string): IdentityRow | null {
  return (
    context.database
      .query<IdentityRow, [string]>('SELECT record_id,project_record_id FROM run WHERE record_id=?')
      .get(recordId) ?? null
  )
}

function runByNumber(context: IdentityContext, number: number): IdentityRow | null {
  return (
    context.database
      .query<IdentityRow, [number]>('SELECT record_id,project_record_id FROM run WHERE number=?')
      .get(number) ?? null
  )
}

function questionProjectId(context: IdentityContext, row: Record<string, unknown>): string | null {
  const runRecordId = typeof row.run_record_id === 'string' ? row.run_record_id : null
  if (runRecordId) return runById(context, runRecordId)?.project_record_id ?? null
  const cursorRecordId =
    typeof row.workflow_cursor_record_id === 'string' ? row.workflow_cursor_record_id : null
  if (!cursorRecordId) return null
  return (
    context.database
      .query<{ project_record_id: string | null }, [string]>(
        'SELECT project_record_id FROM workflow_cursor WHERE record_id=?',
      )
      .get(cursorRecordId)?.project_record_id ?? null
  )
}

const kindForPrefix = (prefix: string): ResolvableKind | null =>
  (Object.entries(IDENTITY_KINDS).find(([, declaration]) => declaration.prefix === prefix)?.[0] as
    | ResolvableKind
    | undefined) ?? null

function scopedProject(
  context: IdentityContext,
  qualifier: { kind: string; value: string } | null,
) {
  if (!qualifier) return { projectId: context.projectId, projectName: context.projectName }
  if (qualifier.kind !== 'project')
    return { projectId: context.projectId, projectName: context.projectName }
  const project = projectByName(qualifier.value, context.database)
  return { projectId: project?.recordId ?? null, projectName: qualifier.value }
}

function visibilityRefusal(scope: string): never {
  throw new Error(`reference is not visible in ${scope}; pass the UUID or a qualified label`)
}

export async function resolve(
  reference: string | number,
  context: IdentityContext,
  expectedKind?: ResolvableKind,
): Promise<ResolvedIdentity> {
  const cacheKey = `${expectedKind ?? ''}:${String(reference)}`
  const cached = context.identityMap.get(cacheKey)
  if (cached) return cached
  const parsed = parseReference(reference, expectedKind)
  if (parsed.value.kind === 'task-key')
    throw new Error(`task reference ${parsed.value.key} is not migrated to identity resolution`)
  const kind =
    parsed.value.kind === 'label'
      ? kindForPrefix(parsed.value.prefix)
      : parsed.value.kind === 'number'
        ? parsed.value.referenceKind
        : expectedKind
  if (!kind) {
    const run = runById(context, parsed.value.recordId)
    if (run) {
      const result: ResolvedIdentity = {
        kind: 'run',
        recordId: run.record_id,
        projectId: run.project_record_id,
        spaceId: projectSpace(context, run.project_record_id),
        authority: IDENTITY_KINDS.run.authority,
      }
      context.identityMap.set(cacheKey, result)
      return result
    }
    const question = await questionById(context.database, parsed.value.recordId)
    if (!question) visibilityRefusal("the caller's visible spaces")
    const projectId = questionProjectId(context, question)
    const result: ResolvedIdentity = {
      kind: 'question',
      recordId: String(question.record_id),
      projectId,
      spaceId: projectSpace(context, projectId),
      authority: IDENTITY_KINDS.question.authority,
    }
    context.identityMap.set(cacheKey, result)
    return result
  }
  if (expectedKind && kind !== expectedKind)
    throw new Error(
      `reference ${JSON.stringify(String(reference))} names a ${kind}, expected ${expectedKind}`,
    )

  let result: ResolvedIdentity | null = null
  if (kind === 'run') {
    const row =
      parsed.value.kind === 'record-id'
        ? runById(context, parsed.value.recordId)
        : runByNumber(context, parsed.value.number)
    if (row)
      result = {
        kind,
        recordId: row.record_id,
        projectId: row.project_record_id,
        spaceId: projectSpace(context, row.project_record_id),
        authority: IDENTITY_KINDS.run.authority,
      }
  } else {
    const scope = scopedProject(context, parsed.qualifier)
    const question =
      parsed.value.kind === 'record-id'
        ? await questionById(context.database, parsed.value.recordId)
        : scope.projectId
          ? await questionByProjectNumber(context.database, parsed.value.number, scope.projectId)
          : null
    if (question) {
      const projectId = questionProjectId(context, question)
      if (parsed.value.kind === 'record-id' || projectId === scope.projectId)
        result = {
          kind,
          recordId: String(question.record_id),
          projectId,
          spaceId: projectSpace(context, projectId),
          authority: IDENTITY_KINDS.question.authority,
        }
    }
    if (!result)
      visibilityRefusal(scope.projectName ? `project ${scope.projectName}` : "the caller's project")
  }
  if (!result) visibilityRefusal('this machine')
  context.identityMap.set(cacheKey, result)
  return result
}
