import { Badge } from '@bottega/hub-ui/badge'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { FolderGit2 } from 'lucide-react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { type ProjectColors, ProjectMark } from '@/components/design-system'

type HostedProject = {
  spaceId: string
  spaceName: string
  name: string
  stack: string | null
  managedContext: boolean
  landingBranch: string | null
  keyPrefixes: string[]
  retiredAt: string | null
}

export function HostedProjects({
  projects,
  colors,
  loaded,
  pending,
  error,
}: {
  projects: HostedProject[]
  colors: ProjectColors
  loaded: boolean
  pending: boolean
  error: string | null
}) {
  const columns: CollectionColumn<HostedProject>[] = [
    { id: 'space', label: 'Space', phone: 'line', render: (project) => project.spaceName },
    {
      id: 'name',
      label: 'Name',
      phone: 'title',
      render: (project) => (
        <span className="flex items-center gap-2 font-semibold">
          <FolderGit2 size={14} />
          <ProjectMark name={project.name} colors={colors} />
        </span>
      ),
    },
    { id: 'stack', label: 'Stack', phone: 'line', render: (project) => project.stack ?? '-' },
    {
      id: 'context',
      label: 'Context',
      phone: 'aside',
      render: (project) => (project.managedContext ? <Badge tone="success">managed</Badge> : '-'),
    },
    {
      id: 'landing',
      label: 'Landing',
      phone: 'more',
      render: (project) => project.landingBranch ?? '-',
    },
    {
      id: 'keys',
      label: 'Keys',
      phone: 'more',
      render: (project) => project.keyPrefixes.join(', ') || '-',
    },
    {
      id: 'retired',
      label: 'Retired',
      phone: 'more',
      render: (project) => (project.retiredAt ? <Badge>retired</Badge> : null),
    },
  ]

  return (
    <section>
      <PageHeader title="Projects" subtitle={`${projects.length} in this space`} />
      {pending ? <p className="text-text-muted">Loading projects...</p> : null}
      {error ? (
        <p data-tone="error" className="text-status-text">
          {error}
        </p>
      ) : null}
      {loaded ? (
        <Collection
          title="Projects"
          count={projects.length}
          columns={columns}
          rows={projects}
          getKey={(project) => `${project.spaceId}:${project.name}`}
          onOpen={() => undefined}
          empty={{ title: 'No projects in this space.' }}
        />
      ) : null}
    </section>
  )
}
