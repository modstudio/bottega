import type { NoteClientOptions } from './note-client.ts'
import { projects } from './projects.ts'
import { hostedTaskIdentity } from './task-client.ts'
import { taskProjectDestination } from './task-project-space.ts'

export async function noteDestinationOptions(
  project: string,
  options: NoteClientOptions = {},
): Promise<NoteClientOptions> {
  const identity = await hostedTaskIdentity(options)
  const destination = taskProjectDestination(project, projects(), identity)
  if ('refused' in destination) {
    if (destination.refused === 'unregistered-project')
      throw new Error(`project '${project}' is not registered; run \`orch project list\``)
    throw new Error(
      `project '${project}' declares a record space the signed-in user is not a member of; run \`orch record space list\``,
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
