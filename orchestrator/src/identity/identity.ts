// concern: record-identity
/** Resolves parsed references through the authority and ownership rules for their kind. */

import type { Database } from 'bun:sqlite'
import {
  IDENTITY_STATE_CLASSES,
  type IdentityAuthority,
} from '../../../shared/identity-state-classes.ts'
import {
  type ParsedReference,
  parseReference,
  REFERENCE_PREFIXES,
  type ReferenceKind,
} from '../../../shared/reference.ts'
import { uuidQualifierRefusal } from '../../../shared/reference-refusal.ts'
import { projectByName, projectByRecordId } from '../project/project-read.ts'
import { cachedProjectSpaces } from '../project-space-cache.ts'
import { questionById, questionByProjectNumber } from '../question-store/question-store-read.ts'
import { decideMachineLabel, type MachineIdentifierNames } from '../record/machine-name.ts'
import {
  type LocalRunIdentity,
  ResolutionMissError,
  resolveLocalRun,
  uuidVisibilityRefusal,
  visibilityRefusal,
} from './identity-local-run.ts'

type ResolvableKind = Exclude<ReferenceKind, 'task'>

const IDENTITY_KINDS = {
  question: {
    table: IDENTITY_STATE_CLASSES.question.table,
    prefix: REFERENCE_PREFIXES.question,
    numberScope: 'space',
    authority: IDENTITY_STATE_CLASSES.question.class,
    ownerChain: 'question → run or cursor',
  },
  run: {
    table: IDENTITY_STATE_CLASSES.run.table,
    prefix: REFERENCE_PREFIXES.run,
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
  machineNames: MachineIdentifierNames | null
  identityMap: Map<string, ResolvedIdentity>
}

const projectSpace = (context: IdentityContext, projectId: string | null): string | null => {
  const project = projectId ? projectByRecordId(projectId, context.database) : null
  return project ? (cachedProjectSpaces(context.database)[project.name] ?? null) : null
}

function runById(context: IdentityContext, recordId: string): LocalRunIdentity | null {
  try {
    return resolveLocalRun(context.database, { kind: 'record-id', recordId })
  } catch (error) {
    if (error instanceof ResolutionMissError) return null
    throw error
  }
}

function questionProjectId(row: Record<string, unknown>): string | null {
  return typeof row.project_record_id === 'string' ? row.project_record_id : null
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
    throw new Error(
      'question references cannot use a machine qualifier; pass a <project>#q<number> reference',
    )
  const project = projectByName(qualifier.value, context.database)
  if (!project) throw new Error(`project ${qualifier.value} is not registered on this machine`)
  return { projectId: project.recordId, projectName: qualifier.value }
}

async function resolveUuid(recordId: string, context: IdentityContext): Promise<ResolvedIdentity> {
  const run = runById(context, recordId)
  if (run)
    return {
      kind: 'run',
      recordId: run.record_id,
      projectId: run.project_record_id,
      spaceId: projectSpace(context, run.project_record_id),
      authority: IDENTITY_KINDS.run.authority,
    }
  const question = await questionById(context.database, recordId)
  if (!question) uuidVisibilityRefusal()
  const projectId = questionProjectId(question)
  return {
    kind: 'question',
    recordId: String(question.record_id),
    projectId,
    spaceId: projectSpace(context, projectId),
    authority: IDENTITY_KINDS.question.authority,
  }
}

function resolveRun(parsed: ParsedReference, context: IdentityContext): ResolvedIdentity {
  const reference =
    parsed.value.kind === 'record-id'
      ? ({ kind: 'record-id', recordId: parsed.value.recordId } as const)
      : 'number' in parsed.value
        ? ({ kind: 'number', number: parsed.value.number } as const)
        : null
  if (!reference) visibilityRefusal('this machine')
  const row = resolveLocalRun(context.database, reference)
  return {
    kind: 'run',
    recordId: row.record_id,
    projectId: row.project_record_id,
    spaceId: projectSpace(context, row.project_record_id),
    authority: IDENTITY_KINDS.run.authority,
  }
}

async function resolveQuestion(
  parsed: ParsedReference,
  context: IdentityContext,
): Promise<ResolvedIdentity> {
  const scope = scopedProject(context, parsed.qualifier)
  const question =
    parsed.value.kind === 'record-id'
      ? await questionById(context.database, parsed.value.recordId)
      : 'number' in parsed.value && scope.projectId
        ? await questionByProjectNumber(context.database, parsed.value.number, scope.projectId)
        : null
  const projectId = question ? questionProjectId(question) : null
  if (!question || (parsed.value.kind !== 'record-id' && projectId !== scope.projectId))
    visibilityRefusal(scope.projectName ? `project ${scope.projectName}` : "the caller's project")
  return {
    kind: 'question',
    recordId: String(question.record_id),
    projectId,
    spaceId: projectSpace(context, projectId),
    authority: IDENTITY_KINDS.question.authority,
  }
}

function parsedKind(parsed: ParsedReference, expectedKind?: ResolvableKind): ResolvableKind | null {
  if (parsed.value.kind === 'label') return kindForPrefix(parsed.value.prefix)
  if (parsed.value.kind === 'number') return parsed.value.referenceKind
  return expectedKind ?? null
}

async function resolveRecordId(
  parsed: ParsedReference,
  context: IdentityContext,
): Promise<ResolvedIdentity> {
  if (parsed.value.kind !== 'record-id')
    throw new Error('an unkinded reference must be a record id')
  return resolveUuid(parsed.value.recordId, context)
}

function validateRunQualifier(
  reference: string | number,
  parsed: ParsedReference,
  context: IdentityContext,
): void {
  if (parsed.qualifier?.kind === 'project')
    throw new Error(
      'run references cannot use a project qualifier because run numbers are per machine',
    )
  if (parsed.qualifier?.kind !== 'machine') return
  const decision = decideMachineLabel(String(reference), context.machineNames)
  if (decision.kind === 'refused') throw new Error(decision.reason)
  if (decision.kind !== 'bare')
    throw new Error(`invalid run reference ${JSON.stringify(String(reference))}`)
}

export async function resolveParsedReference(
  parsed: ParsedReference,
  reference: string | number,
  context: IdentityContext,
  expectedKind?: ResolvableKind,
): Promise<ResolvedIdentity> {
  const cacheKey = `${expectedKind ?? ''}:${String(reference)}`
  const cached = context.identityMap.get(cacheKey)
  if (cached) return cached
  if (parsed.value.kind === 'task-key')
    throw new Error(`task reference ${parsed.value.key} is not migrated to identity resolution`)
  const kind = parsedKind(parsed, expectedKind)
  if (!kind && parsed.value.kind !== 'record-id')
    throw new Error(`reference ${JSON.stringify(String(reference))} has no migrated kind`)
  if (expectedKind && kind !== expectedKind)
    throw new Error(
      `reference ${JSON.stringify(String(reference))} names a ${kind}, expected ${expectedKind}`,
    )
  if (parsed.qualifier && parsed.value.kind === 'record-id')
    throw new Error(uuidQualifierRefusal())
  if (kind === 'run') validateRunQualifier(reference, parsed, context)

  const result = !kind
    ? await resolveRecordId(parsed, context)
    : kind === 'run'
      ? resolveRun(parsed, context)
      : await resolveQuestion(parsed, context)
  context.identityMap.set(cacheKey, result)
  return result
}

export async function resolve(
  reference: string | number,
  context: IdentityContext,
  expectedKind?: ResolvableKind,
): Promise<ResolvedIdentity> {
  return resolveParsedReference(
    parseReference(reference, expectedKind),
    reference,
    context,
    expectedKind,
  )
}
