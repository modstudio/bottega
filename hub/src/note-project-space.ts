import { hostedWriteDestination } from './hosted-write-destination.ts'
import { hostedNoteIdentity, type NoteClientOptions, type NoteWriteOptions } from './note-client.ts'
import { projects } from './projects.ts'
import { taskProjectDestination } from './task-project-space.ts'

export async function noteDestinationOptions(
  project: string | null,
  options: NoteClientOptions = {},
): Promise<NoteWriteOptions> {
  if (options.recordSpace) return { ...options, recordSpace: options.recordSpace }
  return { ...options, recordSpace: await hostedWriteDestination(project, options) }
}

export async function noteReadSpaces(
  project: string | undefined,
  options: NoteClientOptions,
): Promise<string[]> {
  const identity = await hostedNoteIdentity(options)
  return project
    ? [await hostedWriteDestination(project, options, identity)]
    : notePullSpaces(projects(), identity)
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
