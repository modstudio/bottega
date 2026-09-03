import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronRight, FolderGit2, Plus } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/design-system'
import { toast } from '@/components/toaster'
import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Checkbox } from '@/components/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/dialog'
import { Input } from '@/components/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/table'
import { queryClient, trpc, type ProjectRow } from '@/trpc/client'

function trackerKind(settings: ProjectRow['settings']) {
  const tracker = settings.tracker as Record<string, unknown> | undefined
  if (!tracker) return 'none'
  const trackerKind = typeof tracker.kind === 'string' ? tracker.kind : null
  const protocol = typeof tracker.protocol === 'string' ? tracker.protocol : null
  const kind = trackerKind || protocol
  if (trackerKind && protocol && trackerKind !== protocol) return `${trackerKind} (${protocol})`
  return kind || 'configured'
}

function worktreeMode(settings: ProjectRow['settings']) {
  const worktree = settings.worktree
  if (!worktree || typeof worktree !== 'object' || Array.isArray(worktree)) return 'neither'
  const value = worktree as Record<string, unknown>
  if (typeof value.create === 'string' && value.create) return 'create'
  if (value.recipe && typeof value.recipe === 'object' && !Array.isArray(value.recipe)) return 'recipe'
  return 'neither'
}

function useProjects() {
  return useQuery(trpc.project.list.queryOptions())
}

export const Route = createFileRoute('/projects')({ component: ProjectsPage })

function ProjectsPage() {
  const projects = useProjects()
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [stack, setStack] = useState('')
  const [canon, setCanon] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const add = useMutation(trpc.project.add.mutationOptions({
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
  }))

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    add.mutate({ path, ...(name ? { name } : {}), ...(stack ? { stack } : {}), canon })
  }

  return (
    <section>
      <PageHeader title="Projects" subtitle={`${projects.data?.length ?? 0} registered`} actions={<Button size="sm" onClick={() => setAdding(true)}><Plus size={14} />Add project</Button>} />
      {projects.isPending ? <p className="text-muted-foreground">Loading register...</p> : null}
      {projects.error ? <p className="text-destructive">{projects.error.message}</p> : null}
      {projects.data ? (
        <div className="border border-border">
          <Table className="text-[12.5px]">
            <TableHeader><TableRow>
              <TableHead className="h-9 px-3">Name</TableHead>
              <TableHead className="h-9 px-3">Stack</TableHead>
              <TableHead className="h-9 px-3">Path</TableHead>
              <TableHead className="h-9 px-3">Canon</TableHead>
              <TableHead className="h-9 px-3">Tracker</TableHead>
              <TableHead className="h-9 px-3">Worktree</TableHead>
              <TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {projects.data.map((project) => (
                <TableRow key={project.id} className="relative hover:bg-muted/50">
                  <TableCell className="px-3 py-2 font-semibold">
                    <Link to="/projects/$name" params={{ name: project.name }} className="flex items-center gap-2 after:absolute after:inset-0">
                      <FolderGit2 size={14} />{project.name}
                    </Link>
                  </TableCell>
                  <TableCell className="px-3 py-2">{project.stack ?? '-'}</TableCell>
                  <TableCell className="max-w-sm truncate px-3 py-2 text-muted-foreground">{project.path}</TableCell>
                  <TableCell className="px-3 py-2">{project.canon ? <Badge variant="outline">canon</Badge> : '-'}</TableCell>
                  <TableCell className="px-3 py-2">{trackerKind(project.settings)}</TableCell>
                  <TableCell className="px-3 py-2">{worktreeMode(project.settings)}</TableCell>
                  <TableCell><ChevronRight size={14} className="text-muted-foreground" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!projects.data.length ? <EmptyState title="No projects are registered." hint="Add a project to make it available throughout hub." /> : null}
        </div>
      ) : null}
      <Dialog open={adding} onOpenChange={(open) => { setAdding(open); if (!open) setError(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
            <DialogDescription>Register a checkout through orch.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submit}>
            <label className="block space-y-1"><span>Path</span><Input required value={path} onChange={(event) => setPath(event.target.value)} /></label>
            <label className="block space-y-1"><span>Name</span><Input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label className="block space-y-1"><span>Stack</span><Input value={stack} onChange={(event) => setStack(event.target.value)} /></label>
            <label className="flex items-center gap-2"><Checkbox checked={canon} onChange={(event) => setCanon(event.target.checked)} />Canon</label>
            {error ? <p className="text-destructive">{error}</p> : null}
            <Button type="submit" disabled={add.isPending}><Plus size={14} />{add.isPending ? 'Adding...' : 'Add project'}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
