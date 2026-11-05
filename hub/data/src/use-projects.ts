import { useQuery } from '@tanstack/react-query'
import { hostedTrpc, type HostedProjectRow, trpc } from './client.ts'
import { isHostedMode } from './hub-mode.ts'

export type HostedProjectColors = Record<string, { light: string | null; dark: string | null }>

function hostedProjectColors(projects: HostedProjectRow[]): HostedProjectColors {
  const colors: HostedProjectColors = {}
  for (const project of projects) {
    colors[project.name] = { light: project.color, dark: project.colorDark }
  }
  return colors
}

export function useHostedProjects(enabled = true) {
  const query = useQuery({ ...trpc.record.projects.queryOptions(), enabled })
  const projects = query.data ?? []
  return {
    projects,
    colors: hostedProjectColors(projects),
    loaded: query.data !== undefined,
    pending: query.isPending,
    error: query.error?.message ?? null,
  }
}

/** Projects exposed by the context router for the dashboard's current mode. */
export function useContextProjects() {
  const hosted = isHostedMode()
  const local = useQuery({ ...trpc.context.projects.queryOptions(), enabled: !hosted })
  const remote = useQuery({ ...hostedTrpc.context.projects.queryOptions(), enabled: hosted })
  return hosted ? remote : local
}
