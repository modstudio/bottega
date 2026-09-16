import { useQuery } from '@tanstack/react-query'
import { FolderGit2 } from 'lucide-react'
import { Badge } from '@/components/badge'
import { Collection, type CollectionColumn } from '@/components/collection'
import { PageHeader, type ProjectColors, ProjectMark } from '@/components/design-system'
import { trpc } from '@/trpc/client'

type HostedProject = {
  name: string
  keyPrefixes: string[]
  stack: string | null
  landingBranch: string | null
  color: string | null
  colorDark: string | null
  retiredAt: string | null
}

export function hostedProjectColors(projects: HostedProject[]): ProjectColors {
  const colors: ProjectColors = {}
  for (const project of projects) {
    colors[project.name] = { light: project.color, dark: project.colorDark }
  }
  return colors
}

export function HostedProjects() {
  const query = useQuery(trpc.record.projects.queryOptions())
  const colors = hostedProjectColors(query.data ?? [])
  const columns: CollectionColumn<HostedProject>[] = [
    {
      id: 'name',
      label: 'Name',
      render: (project) => (
        <span className="flex items-center gap-2 font-semibold">
          <FolderGit2 size={14} />
          <ProjectMark name={project.name} colors={colors} />
        </span>
      ),
    },
    { id: 'stack', label: 'Stack', render: (project) => project.stack ?? '-' },
    {
      id: 'landing',
      label: 'Landing',
      render: (project) => project.landingBranch ?? '-',
    },
    {
      id: 'keys',
      label: 'Keys',
      render: (project) => project.keyPrefixes.join(', ') || '-',
    },
    {
      id: 'retired',
      label: '',
      render: (project) => (project.retiredAt ? <Badge variant="outline">retired</Badge> : null),
    },
  ]

  return (
    <section>
      <PageHeader title="Projects" subtitle={`${query.data?.length ?? 0} in this space`} />
      {query.isPending ? <p className="text-muted-foreground">Loading projects...</p> : null}
      {query.error ? <p className="text-destructive">{query.error.message}</p> : null}
      {query.data ? (
        <Collection
          title="Projects"
          count={query.data.length}
          columns={columns}
          rows={query.data}
          getKey={(project) => project.name}
          onOpen={() => undefined}
          empty={{ title: 'No projects in this space.' }}
        />
      ) : null}
    </section>
  )
}
