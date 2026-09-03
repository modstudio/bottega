import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Copy, Save, Trash2 } from 'lucide-react'
import { toast } from '@/components/toaster'
import { Button } from '@/components/button'
import { Checkbox } from '@/components/checkbox'
import { Input } from '@/components/input'
import { Textarea } from '@/components/textarea'
import { queryClient, trpc, type ProjectRow } from '@/trpc/client'
import { PageHeader } from '@/components/design-system'

export const Route = createFileRoute('/projects/$name')({ component: ProjectEditPage })

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function settingsCommand(name: string, value: Record<string, unknown>) {
  return `orch project set ${shellQuote(name)} --settings ${shellQuote(JSON.stringify(value))}`
}

function CommandHint({ command }: { command: string }) {
  const copy = async () => {
    await navigator.clipboard.writeText(command)
    toast.success('Command copied')
  }
  return (
    <button type="button" onClick={copy} className="flex max-w-full items-center gap-1 truncate text-left font-mono text-[10px] text-muted-foreground hover:text-foreground" title={command}>
      <Copy size={11} className="shrink-0" />{command}
    </button>
  )
}

function pretty(value: unknown) {
  return value === undefined ? '' : JSON.stringify(value, null, 2)
}

function ProjectEditPage() {
  const { name } = Route.useParams()
  const projects = useQuery(trpc.project.list.queryOptions())
  const project = projects.data?.find((candidate) => candidate.name === name)

  if (projects.isPending) return <p className="text-muted-foreground">Loading register...</p>
  if (projects.error) return <p className="text-destructive">{projects.error.message}</p>
  if (!project) return <p className="text-destructive">No project &quot;{name}&quot;</p>
  return <ProjectForm key={project.id} project={project} />
}

function ProjectForm({ project }: { project: ProjectRow }) {
  const navigate = useNavigate()
  const initialTrunk = typeof project.settings.trunk === 'string' ? project.settings.trunk : ''
  const initialPrefixes = Array.isArray(project.settings.keyPrefixes) ? project.settings.keyPrefixes : []
  const initialColor = typeof project.settings.color === 'string' ? project.settings.color : ''
  const initialColorDark = typeof project.settings.colorDark === 'string' ? project.settings.colorDark : ''
  const [path, setPath] = useState(project.path)
  const [stack, setStack] = useState(project.stack ?? '')
  const [canon, setCanon] = useState(project.canon)
  const [trunk, setTrunk] = useState(initialTrunk)
  const [keyPrefixes, setKeyPrefixes] = useState(initialPrefixes.join(', '))
  const [color, setColor] = useState(initialColor)
  const [colorDark, setColorDark] = useState(initialColorDark)
  const [tracker, setTracker] = useState(pretty(project.settings.tracker))
  const [worktree, setWorktree] = useState(pretty(project.settings.worktree))
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const prefixes = keyPrefixes.split(',').map((value) => value.trim()).filter(Boolean)
  const changed = path !== project.path || stack !== (project.stack ?? '') || canon !== project.canon
    || trunk !== initialTrunk || JSON.stringify(prefixes) !== JSON.stringify(initialPrefixes)
    || color !== initialColor || colorDark !== initialColorDark
    || tracker !== pretty(project.settings.tracker) || worktree !== pretty(project.settings.worktree)

  const save = useMutation(trpc.project.set.mutationOptions({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })
      setError(null)
      toast.success(`Saved ${project.name}`)
    },
    onError: (cause) => setError(cause.message),
  }))
  const remove = useMutation(trpc.project.remove.mutationOptions({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })
      toast.success(`Removed ${project.name}`)
      await navigate({ to: '/projects' })
    },
    onError: (cause) => setError(cause.message),
  }))

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    let trackerValue: unknown
    let worktreeValue: unknown
    try {
      trackerValue = tracker.trim() ? JSON.parse(tracker) : null
    } catch (cause) {
      setError(`Tracker must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
      return
    }
    try {
      worktreeValue = worktree.trim() ? JSON.parse(worktree) : null
    } catch (cause) {
      setError(`Worktree must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
      return
    }

    const settings: Record<string, unknown> = {}
    if (trunk !== initialTrunk) settings.trunk = trunk
    if (JSON.stringify(prefixes) !== JSON.stringify(initialPrefixes)) settings.keyPrefixes = prefixes
    if (color !== initialColor) settings.color = color
    if (colorDark !== initialColorDark) settings.colorDark = colorDark
    if (tracker !== pretty(project.settings.tracker)) settings.tracker = trackerValue
    if (worktree !== pretty(project.settings.worktree)) settings.worktree = worktreeValue

    save.mutate({
      name: project.name,
      ...(path !== project.path ? { path } : {}),
      ...(stack !== (project.stack ?? '') ? { stack } : {}),
      ...(canon !== project.canon ? { canon } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
    })
  }

  const trackerCommandValue = (() => {
    try { return tracker.trim() ? JSON.parse(tracker) : null } catch { return tracker }
  })()
  const worktreeCommandValue = (() => {
    try { return worktree.trim() ? JSON.parse(worktree) : null } catch { return worktree }
  })()

  return (
    <section>
      <form onSubmit={submit}>
      <PageHeader title={project.name} subtitle={project.path} actions={<><Button type="submit" disabled={!changed || save.isPending}><Save size={14} />{save.isPending ? 'Saving...' : 'Save changes'}</Button><Button type="button" variant="destructive" disabled={remove.isPending} onClick={() => { if (!confirmRemove) { setConfirmRemove(true); return }; setError(null); remove.mutate({ name: project.name }) }}><Trash2 size={14} />{remove.isPending ? 'Removing...' : confirmRemove ? 'Confirm remove' : 'Remove'}</Button></>} />
      <div className="max-w-[640px] space-y-5">
        <Field label="Path" command={`orch project set ${shellQuote(project.name)} --path ${shellQuote(path)}`}><Input value={path} onChange={(event) => setPath(event.target.value)} /></Field>
        <Field label="Stack" command={`orch project set ${shellQuote(project.name)} --stack ${shellQuote(stack)}`}><Input value={stack} onChange={(event) => setStack(event.target.value)} /></Field>
        <Field label="Canon" command={`orch project set ${shellQuote(project.name)} ${canon ? '--canon' : '--no-canon'}`}><label className="flex items-center gap-2"><Checkbox checked={canon} onChange={(event) => setCanon(event.target.checked)} />Included in canon</label></Field>
        <Field label="Trunk" command={settingsCommand(project.name, { trunk })}><Input value={trunk} onChange={(event) => setTrunk(event.target.value)} /></Field>
        <Field label="Key prefixes" command={settingsCommand(project.name, { keyPrefixes: prefixes })}><Input value={keyPrefixes} onChange={(event) => setKeyPrefixes(event.target.value)} placeholder="DEV, HUB" /></Field>
        <Field label="Color" command={settingsCommand(project.name, { color })}><Input value={color} onChange={(event) => setColor(event.target.value)} /></Field>
        <Field label="Color dark" command={settingsCommand(project.name, { colorDark })}><Input value={colorDark} onChange={(event) => setColorDark(event.target.value)} /></Field>
        <Field label="Tracker" command={settingsCommand(project.name, { tracker: trackerCommandValue })}><Textarea rows={12} className="font-mono text-[12.5px]" value={tracker} onChange={(event) => setTracker(event.target.value)} /></Field>
        <Field label="Worktree" command={settingsCommand(project.name, { worktree: worktreeCommandValue })}><Textarea rows={12} className="font-mono text-[12.5px]" value={worktree} onChange={(event) => setWorktree(event.target.value)} /></Field>
        {error ? <p className="text-destructive">{error} Correct the field and try again.</p> : null}
      </div>
      </form>
    </section>
  )
}

function Field({ label, command, children }: { label: string; command: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[12.5px] text-muted-foreground">{label}</label>
      <div>{children}</div>
      <CommandHint command={command} />
    </div>
  )
}
