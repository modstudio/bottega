import { useQuery } from '@tanstack/react-query'
import { FolderGit2 } from 'lucide-react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { type ProjectColors, ProjectMark } from '@/components/design-system'
import { type HostedProjectRow as HostedProject, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { PageHeader } from '@/ui/page-header/page-header'

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
    { id: 'space', label: 'Space', render: (project) => project.spaceName },
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
      id: 'context',
      label: 'Context',
      render: (project) => (project.managedContext ? <Badge tone="success">managed</Badge> : '-'),
    },
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
      render: (project) => (project.retiredAt ? <Badge>retired</Badge> : null),
    },
  ]

  return (
    <section>
      <PageHeader title="Projects" subtitle={`${query.data?.length ?? 0} in this space`} />
      {query.isPending ? <p className="text-text-muted">Loading projects...</p> : null}
      {query.error ? (
        <p data-tone="error" className="text-status-text">
          {query.error.message}
        </p>
      ) : null}
      {query.data ? (
        <Collection
          title="Projects"
          count={query.data.length}
          columns={columns}
          rows={query.data}
          getKey={(project) => `${project.spaceId}:${project.name}`}
          onOpen={() => undefined}
          empty={{ title: 'No projects in this space.' }}
        />
      ) : null}
    </section>
  )
}
