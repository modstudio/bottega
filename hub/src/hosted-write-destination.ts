import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { undeclaredProjectSpaceRefusal } from '../../shared/record-remedies.ts'
import { type PersonalRecordSpaceOptions, personalRecordSpace } from './personal-record-space.ts'
import { projects } from './projects.ts'
import { hostedTaskIdentity } from './task-client.ts'
import { taskProjectDestination } from './task-project-space.ts'

export type HostedWriteDestinationOptions = PersonalRecordSpaceOptions & {
  baseUrl?: string
  personalSpace?: Promise<string>
}

/** Resolve a hosted write owner through the same project-or-personal policy as record sync. */
export async function hostedWriteDestination(
  project: string | null,
  options: HostedWriteDestinationOptions = {},
): Promise<string> {
  if (project === null) return options.personalSpace ?? personalRecordSpace(options)
  const identity = await hostedTaskIdentity(options)
  const destination = taskProjectDestination(project, projects(), identity)
  if ('destinationSpaceId' in destination) return destination.destinationSpaceId
  if (destination.refused === 'unregistered-project')
    throw new Error(`project '${project}' is not registered; run \`${PLATFORM_SLUG} project list\``)
  if (destination.refused === 'undeclared-project')
    throw new Error(undeclaredProjectSpaceRefusal(project))
  throw new Error(
    `project '${project}' declares a record space the signed-in user is not a member of; run \`${PLATFORM_SLUG} record space list\``,
  )
}
