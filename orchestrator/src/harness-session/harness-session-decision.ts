// concern: harness session publication decisions

export type HarnessProcessIdentity = { pid: number; startTime: string }

export type HarnessSessionPublication = {
  identity: HarnessProcessIdentity
  session: string
  harness: 'claude-code'
  source: string
  published_at: string
}

/** Find live harness processes for which no publication matches both pid and birth time. */
export function unpublishedHarnessProcesses(
  processes: readonly HarnessProcessIdentity[],
  publications: readonly Pick<HarnessSessionPublication, 'identity'>[],
): HarnessProcessIdentity[] {
  const published = new Set(
    publications.map(({ identity }) => `${identity.pid}\0${identity.startTime}`),
  )
  return processes.filter(({ pid, startTime }) => !published.has(`${pid}\0${startTime}`))
}
