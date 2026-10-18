import { useQuery } from '@tanstack/react-query'
import { trpc } from './client.ts'
import { isHostedMode } from './hub-mode.ts'
import { useHostedProjects } from './use-projects.ts'

export type ProjectColors = Record<string, { light: string | null; dark: string | null }>

function projectColors(projects: readonly { name: string; settings: unknown }[]): ProjectColors {
  const colors: ProjectColors = {}
  for (const project of projects) {
    const settings = project.settings as { color?: string; colorDark?: string }
    colors[project.name] = { light: settings.color ?? null, dark: settings.colorDark ?? null }
  }
  return colors
}

export function useProjectColors(): ProjectColors {
  const hosted = isHostedMode()
  const local = useQuery({
    ...trpc.project.list.queryOptions(),
    staleTime: 60_000,
    enabled: !hosted,
  })
  const remote = useHostedProjects(hosted)
  return hosted ? remote.colors : projectColors(local.data ?? [])
}
