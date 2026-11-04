// concern: hosted-outside-notes
/** Files and reads a signed-in non-member's notes against a space intake project. */

import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { type NoteAnchorWire, parseNoteAnchorWire } from '../../shared/note-anchor.ts'
import {
  outsideAdmission,
  outsideWriteDecisionForUser,
  resolveOutsideIntake,
} from '../../shared/outside-write-adapter.ts'
import { newRecordId } from '../../shared/record-id.ts'
import { type TaskIdentity, withHostedTenant } from './hosted-tenant.ts'

type OutsideNoteRow = {
  id: string
  number: number
  project: string
  text: string
  area: string | null
  anchors: NoteAnchorWire[]
  sightings: number
  created_at: string
}

const rows = <T>(value: unknown) => value as T[]

export class HostedOutsideNoteError extends Error {
  readonly status: number
  readonly remedy?: string
  constructor(message: string, status: number, remedy?: string) {
    super(message)
    this.status = status
    this.remedy = remedy
  }
}

function parsedAnchor(anchor: string): string {
  try {
    return JSON.stringify(parseNoteAnchorWire(JSON.parse(anchor)))
  } catch {
    throw new HostedOutsideNoteError(
      'outside note anchor is malformed',
      400,
      'Pass the JSON note anchor produced by the note command.',
    )
  }
}

export async function insertOutsideNote(
  url: SQL,
  identity: TaskIdentity,
  input: { project: string; text: string; area?: string | null; anchor: string },
): Promise<{ id: string; number: number; project: string }> {
  return withHostedTenant(url, identity, async (tx) => {
    const intake = await resolveOutsideIntake(tx, input.project)
    if (intake.kind === 'multiple') throw new HostedOutsideNoteError(intake.refusal, 409)
    if (intake.kind === 'none')
      throw new HostedOutsideNoteError(
        `project '${input.project}' does not accept outside notes`,
        404,
        `register the project with \`${PLATFORM_SLUG} project add\` if you belong to its space, or ask the project's space owner to accept outside notes for it`,
      )
    const admission = await outsideAdmission(tx, identity.userId, intake.spaceId)
    if (admission.kind === 'member')
      throw new HostedOutsideNoteError(
        `you are a member of this space; register the project with \`${PLATFORM_SLUG} project add\` and file the note normally`,
        409,
      )
    if (admission.kind === 'refused')
      throw new HostedOutsideNoteError(admission.error, 403, admission.remedy)

    const anchor = parsedAnchor(input.anchor)
    const createdAt = new Date().toISOString()
    const decision = await outsideWriteDecisionForUser(tx, {
      userId: identity.userId,
      createdAt,
      body: input.text,
      area: input.area ?? null,
      anchorLength: anchor.length,
    })
    if (!decision)
      throw new HostedOutsideNoteError('signed-in note user no longer exists; sign in again', 403)
    if (!decision.allowed) throw new HostedOutsideNoteError(decision.refusal, decision.status)

    const id = newRecordId()
    const inserted = rows<{ id: string; number: number }>(
      await tx`SELECT id::text,number::int FROM public.hub_note_insert_outside(
        ${id}::uuid,${newRecordId()}::uuid,${identity.userId}::uuid,${intake.projectId}::uuid,
        ${input.project},${input.text},${input.area ?? null},${anchor},${createdAt}::timestamptz
      )`,
    )[0]!
    return { id: inserted.id, number: inserted.number, project: input.project }
  })
}

export async function listOutsideNotes(
  url: SQL,
  identity: TaskIdentity,
  project: string,
): Promise<OutsideNoteRow[]> {
  return withHostedTenant(url, identity, async (tx) => {
    const intake = await resolveOutsideIntake(tx, project)
    if (intake.kind === 'multiple') throw new HostedOutsideNoteError(intake.refusal, 409)
    if (intake.kind === 'none')
      throw new HostedOutsideNoteError(
        `project '${project}' does not accept outside notes`,
        404,
        `register the project with \`${PLATFORM_SLUG} project add\` if you belong to its space, or ask the project's space owner to accept outside notes for it`,
      )
    const notes = rows<Omit<OutsideNoteRow, 'anchors'> & { anchors: string }>(
      await tx`SELECT id::text,number::int,project_name AS project,text,area,anchors,sightings,created_at::text
        FROM hub_note
        WHERE space_id=${intake.spaceId}::uuid AND project_id=${intake.projectId}::uuid
          AND author_user_id=${identity.userId}::uuid
          AND deleted_at IS NULL
        ORDER BY created_at DESC,id DESC`,
    )
    return notes.map((note) => ({
      ...note,
      anchors: (JSON.parse(note.anchors) as unknown[]).map(parseNoteAnchorWire),
    }))
  })
}
