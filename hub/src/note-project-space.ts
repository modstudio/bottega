import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { NoteClientOptions } from './note-client.ts'
import { projects } from './projects.ts'
import { hostedSignedInUser, hostedTaskIdentity } from './task-client.ts'
import { taskProjectDestination } from './task-project-space.ts'

async function personalNoteOptions(options: NoteClientOptions): Promise<NoteClientOptions> {
  const personalSpaceId = (await hostedSignedInUser(options))?.personalSpaceId
  if (!personalSpaceId) throw new Error('record user has no personal space')
  return { ...options, recordSpace: personalSpaceId }
}

export async function noteDestinationOptions(
  project: string | null,
  options: NoteClientOptions = {},
): Promise<NoteClientOptions> {
  if (options.recordSpace) return options
  if (project === null) return personalNoteOptions(options)
  const registered = projects().find((candidate) => candidate.name === project)
  if (!registered) return personalNoteOptions(options)
  const identity = await hostedTaskIdentity(options)
  const destination = taskProjectDestination(project, projects(), identity)
  if ('refused' in destination) {
    if (destination.refused === 'unregistered-project')
      throw new Error(
        `project '${project}' is not registered; run \`${PLATFORM_SLUG} project list\``,
      )
    if (destination.refused === 'undeclared-project') return personalNoteOptions(options)
    throw new Error(
      `project '${project}' declares a record space the signed-in user is not a member of; run \`${PLATFORM_SLUG} record space list\``,
    )
  }
  return { ...options, recordSpace: destination.destinationSpaceId }
}

export function notePullSpaces(
  registered: Parameters<typeof taskProjectDestination>[1],
  identity: Parameters<typeof taskProjectDestination>[2],
): string[] {
  const spaces = new Set([identity.activeSpaceId])
  for (const project of registered) {
    const destination = taskProjectDestination(project.name, registered, identity)
    if ('destinationSpaceId' in destination) spaces.add(destination.destinationSpaceId)
  }
  return [...spaces]
}
