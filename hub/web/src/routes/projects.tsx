import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { ChevronRight, FolderGit2, Plus } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Checkbox } from '@/components/checkbox'
import { Collection, type CollectionColumn } from '@/components/collection'
import { PageHeader } from '@/components/design-system'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/dialog'
import { Input } from '@/components/input'
import { toast } from '@/components/toaster'
import { type ProjectRow, queryClient, trpc } from '@/trpc/client'

function TrackerState({ project }: { project: ProjectRow }) {
  const status = project.trackerStatus
  if (status.state === 'not-configured') {
    return <Badge variant="outline">not configured</Badge>
  }
  if (status.state === 'unusable') {
    return (
      <div>
        <Badge variant="danger">unusable</Badge>
        <div className="mt-1 max-w-xs text-[11px] text-destructive">{status.error}</div>
      </div>
    )
  }
  return (
    <div>
      <Badge variant="success">configured</Badge> <span>{status.label}</span>
    </div>
  )
}

function worktreeMode(settings: ProjectRow['settings']) {
  const worktree = settings.worktree
  if (!worktree || typeof worktree !== 'object' || Array.isArray(worktree)) return 'neither'
  const value = worktree as Record<string, unknown>
  if (typeof value.create === 'string' && value.create) return 'create'
  if (value.recipe && typeof value.recipe === 'object' && !Array.isArray(value.recipe))
    return 'recipe'
  return 'neither'
}

function useProjects() {
  return useQuery(trpc.project.list.queryOptions())
}

export const Route = createFileRoute('/projects')({ component: ProjectsRoute })

function ProjectsRoute() {
  return (
    <>
      <ProjectsPage />
      <Outlet />
    </>
  )
}

function ProjectsPage() {
  const navigate = useNavigate()
  const projects = useProjects()
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [stack, setStack] = useState('')
  const [canon, setCanon] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const add = useMutation(
    trpc.project.add.mutationOptions({
      onSuccess: async (project) => {
        await queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })
        setAdding(false)
        setPath('')
        setName('')
        setStack('')
        setCanon(true)
        setError(null)
        toast.success(`Added ${project.name}`)
      },
      onError: (cause) => setError(cause.message),
    }),
  )

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    add.mutate({ path, ...(name ? { name } : {}), ...(stack ? { stack } : {}), canon })
  }
  const columns: CollectionColumn<ProjectRow>[] = [
    {
      id: 'name',
      label: 'Name',
      render: (project) => (
        <span className="flex items-center gap-2 font-semibold">
          <FolderGit2 size={14} />
          {project.name}
        </span>
      ),
    },
    { id: 'stack', label: 'Stack', render: (project) => project.stack ?? '-' },
    {
      id: 'path',
      label: 'Path',
      render: (project) => (
        <span className="block max-w-sm truncate text-muted-foreground">{project.path}</span>
      ),
    },
    {
      id: 'canon',
      label: 'Canon',
      render: (project) => (project.canon ? <Badge variant="outline">canon</Badge> : '-'),
    },
    { id: 'tracker', label: 'Tracker', render: (project) => <TrackerState project={project} /> },
    { id: 'worktree', label: 'Worktree', render: (project) => worktreeMode(project.settings) },
    {
      id: 'open',
      label: '',
      render: () => <ChevronRight size={14} className="text-muted-foreground" />,
    },
  ]

  return (
    <section>
      <PageHeader
        title="Projects"
        subtitle={`${projects.data?.length ?? 0} registered`}
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={14} />
            Add project
          </Button>
        }
      />
      {projects.isPending ? <p className="text-muted-foreground">Loading register...</p> : null}
      {projects.error ? <p className="text-destructive">{projects.error.message}</p> : null}
      {projects.data ? (
        <Collection
          title="Register"
          count={projects.data.length}
          columns={columns}
          rows={projects.data}
          getKey={(project) => project.id}
          onOpen={(project) =>
            void navigate({ to: '/projects/$name', params: { name: project.name } })
          }
          empty={{ title: 'No projects are registered.' }}
        />
      ) : null}
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open)
          if (!open) setError(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
            <DialogDescription>Register a checkout through orch.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submit}>
            <label htmlFor="new-project-path" className="block space-y-1">
              <span>Path</span>
              <Input
                id="new-project-path"
                required
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            <label htmlFor="new-project-name" className="block space-y-1">
              <span>Name</span>
              <Input
                id="new-project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label htmlFor="new-project-stack" className="block space-y-1">
              <span>Stack</span>
              <Input
                id="new-project-stack"
                value={stack}
                onChange={(event) => setStack(event.target.value)}
              />
            </label>
            <label htmlFor="new-project-canon" className="flex items-center gap-2">
              <Checkbox
                id="new-project-canon"
                checked={canon}
                onChange={(event) => setCanon(event.target.checked)}
              />
              Canon
            </label>
            {error ? <p className="text-destructive">{error}</p> : null}
            <Button type="submit" disabled={add.isPending}>
              <Plus size={14} />
              {add.isPending ? 'Adding...' : 'Add project'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
