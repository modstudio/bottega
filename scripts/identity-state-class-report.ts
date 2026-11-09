import type { StateClassDeclaration } from './identity-state-classes.ts'

export const HOSTED_WRITE_PATHS = ['direct', 'outbox', 'cache', 'local'] as const
type HostedWritePath = (typeof HOSTED_WRITE_PATHS)[number]

export type HostedWritePathReport = {
  counts: Record<HostedWritePath, number>
  paths: Record<HostedWritePath, string[]>
}

export function hostedWritePathReport(
  declarations: readonly StateClassDeclaration[],
  outboxTables: readonly string[],
): HostedWritePathReport {
  const outbox = new Set(outboxTables)
  const paths: Record<HostedWritePath, string[]> = {
    direct: [],
    outbox: [],
    cache: [],
    local: [],
  }
  for (const declaration of declarations) {
    if (!('table' in declaration) || declaration.class !== 'hosted') continue
    const key = `${declaration.store}.${declaration.table}`
    const path = declaration.cache
      ? 'cache'
      : outbox.has(key)
        ? 'outbox'
        : declaration.task
          ? 'local'
          : 'direct'
    paths[path].push(key)
  }
  for (const path of HOSTED_WRITE_PATHS) paths[path].sort()
  return {
    counts: Object.fromEntries(
      HOSTED_WRITE_PATHS.map((path) => [path, paths[path].length]),
    ) as Record<HostedWritePath, number>,
    paths,
  }
}
