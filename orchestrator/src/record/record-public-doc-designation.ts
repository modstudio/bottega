// concern: record-public-doc-designation
/** Owns public-document project designation policy and owner-role persistence. */

import { SQL } from 'bun'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import { currentRecordUserSession } from './record-session.ts'

type PublicDocDesignationAction = 'designate' | 'clear' | 'list'

export type PublicDocDesignationFacts = {
  action: PublicDocDesignationAction
  userId: string | null
  spaceId: string | null
  projectId: string | null
  alreadyDesignated: boolean
  affectedRows: number | null
  spaceSlug: string
  projectName: string
}

export type PublicDocDesignation = {
  space_id: string
  project_id: string
  space_slug: string | null
  project_name: string | null
  resolvable: boolean
}

export function publicDocDesignationRefusal(facts: PublicDocDesignationFacts): string | null {
  if (!facts.userId) return RECORD_SIGN_IN_REMEDY
  if (facts.action === 'list') return null
  if (!facts.spaceId) {
    return `the signed-in user is not a member of record space "${facts.spaceSlug}"; join it with an invitation, then retry`
  }
  if (!facts.projectId) {
    return `record project "${facts.projectName}" does not exist in space "${facts.spaceSlug}"; create or sync that project, then retry`
  }
  if (facts.action === 'designate' && facts.alreadyDesignated) return null
  if (facts.action === 'clear' && !facts.alreadyDesignated) {
    return `record project "${facts.projectName}" in space "${facts.spaceSlug}" is not publicly designated; run \`orch record public-doc list\` to see current designations`
  }
  if (facts.affectedRows !== null && facts.affectedRows !== 1) {
    return `${facts.action} changed ${facts.affectedRows} public document designations instead of one; run \`orch record public-doc list\` and retry`
  }
  return null
}

type SqlClient = SQL
type DesignationDependencies = {
  currentUserId(actorUrl: string): Promise<string | null>
  openOwner(url: string): SqlClient
}

const defaultDependencies: DesignationDependencies = {
  async currentUserId(actorUrl) {
    try {
      return String((await currentRecordUserSession(actorUrl)).user.id)
    } catch (error) {
      if (error instanceof Error && error.message === RECORD_SIGN_IN_REMEDY) return null
      throw error
    }
  },
  openOwner: (url) => new SQL(url),
}

function refuse(message: string | null): void {
  if (message) throw new Error(message)
}

async function lookupTarget(
  tx: SQL,
  input: { userId: string; spaceSlug: string; projectName: string },
): Promise<{ spaceId: string | null; projectId: string | null; alreadyDesignated: boolean }> {
  await tx`SELECT set_config('app.user_id', ${input.userId}, true)`
  await tx`SELECT set_config('app.space_id', '', true)`
  const spaces = await tx`SELECT id FROM space WHERE slug=${input.spaceSlug}`
  const spaceId = spaces[0]?.id ? String(spaces[0].id) : null
  if (!spaceId) return { spaceId: null, projectId: null, alreadyDesignated: false }
  await tx`SELECT set_config('app.space_id', ${spaceId}, true)`
  const projects = await tx`
    SELECT id FROM project WHERE space_id=${spaceId}::uuid AND name=${input.projectName}
  `
  const projectId = projects[0]?.id ? String(projects[0].id) : null
  if (!projectId) return { spaceId, projectId: null, alreadyDesignated: false }
  const existing = await tx`
    SELECT 1 FROM public_doc_space
    WHERE space_id=${spaceId}::uuid AND project_id=${projectId}::uuid
  `
  return { spaceId, projectId, alreadyDesignated: existing.length === 1 }
}

export async function designatePublicDocProject(
  input: { actorUrl: string; ownerUrl: string; spaceSlug: string; projectName: string },
  dependencies: DesignationDependencies = defaultDependencies,
): Promise<{ changed: boolean; spaceId: string; projectId: string }> {
  const userId = await dependencies.currentUserId(input.actorUrl)
  refuse(
    publicDocDesignationRefusal({
      action: 'list',
      userId,
      spaceId: null,
      projectId: null,
      alreadyDesignated: false,
      affectedRows: null,
      spaceSlug: input.spaceSlug,
      projectName: input.projectName,
    }),
  )
  const client = dependencies.openOwner(input.ownerUrl)
  try {
    return await client.begin(async (tx) => {
      const target = await lookupTarget(tx, {
        userId: userId!,
        spaceSlug: input.spaceSlug,
        projectName: input.projectName,
      })
      const facts = {
        action: 'designate' as const,
        userId,
        ...target,
        affectedRows: null,
        spaceSlug: input.spaceSlug,
        projectName: input.projectName,
      }
      refuse(publicDocDesignationRefusal(facts))
      if (target.alreadyDesignated) {
        return { changed: false, spaceId: target.spaceId!, projectId: target.projectId! }
      }
      const inserted = await tx`
        INSERT INTO public_doc_space (space_id, project_id)
        VALUES (${target.spaceId!}::uuid, ${target.projectId!}::uuid)
        ON CONFLICT DO NOTHING RETURNING space_id
      `
      refuse(publicDocDesignationRefusal({ ...facts, affectedRows: inserted.length }))
      return { changed: true, spaceId: target.spaceId!, projectId: target.projectId! }
    })
  } finally {
    await client.close()
  }
}

export async function clearPublicDocProject(
  input: { actorUrl: string; ownerUrl: string; spaceSlug: string; projectName: string },
  dependencies: DesignationDependencies = defaultDependencies,
): Promise<{ spaceId: string; projectId: string }> {
  const userId = await dependencies.currentUserId(input.actorUrl)
  refuse(
    publicDocDesignationRefusal({
      action: 'list',
      userId,
      spaceId: null,
      projectId: null,
      alreadyDesignated: false,
      affectedRows: null,
      spaceSlug: input.spaceSlug,
      projectName: input.projectName,
    }),
  )
  const client = dependencies.openOwner(input.ownerUrl)
  try {
    return await client.begin(async (tx) => {
      const target = await lookupTarget(tx, {
        userId: userId!,
        spaceSlug: input.spaceSlug,
        projectName: input.projectName,
      })
      const facts = {
        action: 'clear' as const,
        userId,
        ...target,
        affectedRows: null,
        spaceSlug: input.spaceSlug,
        projectName: input.projectName,
      }
      refuse(publicDocDesignationRefusal(facts))
      const removed = await tx`
        DELETE FROM public_doc_space
        WHERE space_id=${target.spaceId!}::uuid AND project_id=${target.projectId!}::uuid
        RETURNING space_id
      `
      refuse(publicDocDesignationRefusal({ ...facts, affectedRows: removed.length }))
      return { spaceId: target.spaceId!, projectId: target.projectId! }
    })
  } finally {
    await client.close()
  }
}

export async function listPublicDocProjects(
  input: { actorUrl: string; ownerUrl: string },
  dependencies: DesignationDependencies = defaultDependencies,
): Promise<PublicDocDesignation[]> {
  const userId = await dependencies.currentUserId(input.actorUrl)
  refuse(
    publicDocDesignationRefusal({
      action: 'list',
      userId,
      spaceId: null,
      projectId: null,
      alreadyDesignated: false,
      affectedRows: null,
      spaceSlug: '',
      projectName: '',
    }),
  )
  const client = dependencies.openOwner(input.ownerUrl)
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${userId!}, true)`
      await tx`SELECT set_config('app.space_id', '', true)`
      const rows = await tx`
        SELECT space_id, project_id FROM public_doc_space ORDER BY space_id, project_id
      `
      const designations: PublicDocDesignation[] = []
      for (const row of rows) {
        const spaceId = String(row.space_id)
        const projectId = String(row.project_id)
        await tx`SELECT set_config('app.space_id', '', true)`
        const spaces = await tx`SELECT slug FROM space WHERE id=${spaceId}::uuid`
        if (!spaces[0]) {
          designations.push({
            space_id: spaceId,
            project_id: projectId,
            space_slug: null,
            project_name: null,
            resolvable: false,
          })
          continue
        }
        await tx`SELECT set_config('app.space_id', ${spaceId}, true)`
        const projects = await tx`
          SELECT name FROM project WHERE space_id=${spaceId}::uuid AND id=${projectId}::uuid
        `
        if (!projects[0]) {
          designations.push({
            space_id: spaceId,
            project_id: projectId,
            space_slug: null,
            project_name: null,
            resolvable: false,
          })
          continue
        }
        designations.push({
          space_id: spaceId,
          project_id: projectId,
          space_slug: String(spaces[0].slug),
          project_name: String(projects[0].name),
          resolvable: true,
        })
      }
      return designations
    })
  } finally {
    await client.close()
  }
}
