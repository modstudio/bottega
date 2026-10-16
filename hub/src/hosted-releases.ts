// concern: hosted-releases
/** Owns the hub's canonical hosted project release reading. */
import type { RecordClient } from './record-client.ts'

export async function hostedProjectReleases(
  client: RecordClient,
  input: { projectId: string; limit?: number; cursor?: string },
) {
  const [history, latest] = await Promise.all([
    client.releases(input),
    client.latestReleases(input.projectId),
  ])
  return { history, latest }
}
