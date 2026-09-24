import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Save, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { type ProjectRow, queryClient, trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { Checkbox } from '@/ui/checkbox/checkbox'
import { Input } from '@/ui/field/input'
import { Textarea } from '@/ui/field/textarea'
import { FieldSection, SettingBlock } from '@/ui/form-layout/form-layout'
import { Sheet } from '@/ui/sheet/sheet'
import { toast } from '@/ui/toast/toast'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'

export const Route = createFileRoute('/projects/$name')({ component: ProjectEditPage })

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function settingsCommand(name: string, value: Record<string, unknown>) {
  return `orch project set ${shellQuote(name)} --settings ${shellQuote(JSON.stringify(value))}`
}

function pretty(value: unknown) {
  return value === undefined ? '' : JSON.stringify(value, null, 2)
}

function parseJsonField(text: string): unknown {
  return text.trim() ? JSON.parse(text) : null
}

/** One settings field: its register key, whether the form differs from the register, and its value. */
type SettingsField = [key: string, changed: boolean, value: () => unknown]

/** The settings patch holds only the keys whose field differs from the register. */
function changedSettings(fields: SettingsField[]) {
  return Object.fromEntries(
    fields.filter(([, changed]) => changed).map(([key, , value]) => [key, value()]),
  )
}

function ProjectEditPage() {
  const navigate = useNavigate()
  const { name } = Route.useParams()
  const projects = useQuery(trpc.project.list.queryOptions())
  const project = projects.data?.find((candidate) => candidate.name === name)

  if (projects.isPending)
    return (
      <Sheet open onClose={() => void navigate({ to: '/projects' })} title={name}>
        <p className="text-text-muted">Loading register...</p>
      </Sheet>
    )
  if (projects.error)
    return (
      <Sheet open onClose={() => void navigate({ to: '/projects' })} title={name}>
        <p data-tone="error" className="text-status-text">
          {projects.error.message}
        </p>
      </Sheet>
    )
  if (!project)
    return (
      <Sheet open onClose={() => void navigate({ to: '/projects' })} title={name}>
        <p data-tone="error" className="text-status-text">
          No project &quot;{name}&quot;
        </p>
      </Sheet>
    )
  return <ProjectForm key={project.id} project={project} />
}

function ProjectForm({ project }: { project: ProjectRow }) {
  const navigate = useNavigate()
  const initialTrunk = typeof project.settings.trunk === 'string' ? project.settings.trunk : ''
  const initialPrefixes = Array.isArray(project.settings.keyPrefixes)
    ? project.settings.keyPrefixes
    : []
  const initialColor = typeof project.settings.color === 'string' ? project.settings.color : ''
  const initialColorDark =
    typeof project.settings.colorDark === 'string' ? project.settings.colorDark : ''
  const initialManagedContext = project.settings.managedContext === true
  const [path, setPath] = useState(project.path)
  const [stack, setStack] = useState(project.stack ?? '')
  const [canon, setCanon] = useState(project.canon)
  const [managedContext, setManagedContext] = useState(initialManagedContext)
  const [trunk, setTrunk] = useState(initialTrunk)
  const [keyPrefixes, setKeyPrefixes] = useState(initialPrefixes.join(', '))
  const [color, setColor] = useState(initialColor)
  const [colorDark, setColorDark] = useState(initialColorDark)
  const [tracker, setTracker] = useState(pretty(project.settings.tracker))
  const [worktree, setWorktree] = useState(pretty(project.settings.worktree))
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const prefixes = keyPrefixes
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const settingsFields: SettingsField[] = [
    ['managedContext', managedContext !== initialManagedContext, () => managedContext],
    ['trunk', trunk !== initialTrunk, () => trunk],
    [
      'keyPrefixes',
      JSON.stringify(prefixes) !== JSON.stringify(initialPrefixes),
      () => prefixes,
    ],
    ['color', color !== initialColor, () => color],
    ['colorDark', colorDark !== initialColorDark, () => colorDark],
    ['tracker', tracker !== pretty(project.settings.tracker), () => parseJsonField(tracker)],
    ['worktree', worktree !== pretty(project.settings.worktree), () => parseJsonField(worktree)],
  ]
  const changed =
    path !== project.path ||
    stack !== (project.stack ?? '') ||
    canon !== project.canon ||
    settingsFields.some(([, fieldChanged]) => fieldChanged)

  const save = useMutation(
    trpc.project.set.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })
        setError(null)
        toast.success(`Saved ${project.name}`)
      },
      onError: (cause) => setError(cause.message),
    }),
  )
  const remove = useMutation(
    trpc.project.remove.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })
        toast.success(`Removed ${project.name}`)
        await navigate({ to: '/projects' })
      },
      onError: (cause) => setError(cause.message),
    }),
  )

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      parseJsonField(tracker)
    } catch (cause) {
      setError(
        `Tracker must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      return
    }
    try {
      parseJsonField(worktree)
    } catch (cause) {
      setError(
        `Worktree must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      return
    }

    const settings = changedSettings(settingsFields)

    save.mutate({
      name: project.name,
      ...(path !== project.path ? { path } : {}),
      ...(stack !== (project.stack ?? '') ? { stack } : {}),
      ...(canon !== project.canon ? { canon } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
    })
  }

  const trackerCommandValue = (() => {
    try {
      return tracker.trim() ? JSON.parse(tracker) : null
    } catch {
      return tracker
    }
  })()
  const worktreeCommandValue = (() => {
    try {
      return worktree.trim() ? JSON.parse(worktree) : null
    } catch {
      return worktree
    }
  })()

  return (
    <Sheet
      open
      onClose={() => void navigate({ to: '/projects' })}
      title={project.name}
      subtitle={project.path}
      actions={
        <>
          <Button
            variant="primary"
            type="submit"
            form="project-form"
            disabled={!changed || save.isPending}
          >
            <Save size={14} />
            {save.isPending ? 'Saving...' : 'Save'}
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (!confirmRemove) {
                setConfirmRemove(true)
                return
              }
              setError(null)
              remove.mutate({ name: project.name })
            }}
          >
            <Trash2 size={14} />
            {remove.isPending ? 'Removing...' : confirmRemove ? 'Confirm' : 'Remove'}
          </Button>
        </>
      }
    >
      <form id="project-form" onSubmit={submit} className="space-y-6">
        <FieldSection title="Project" description="Checkout identity and canon participation.">
          <div className="space-y-5">
            <SettingBlock
              label="Path"
              cli={`orch project set ${shellQuote(project.name)} --path ${shellQuote(path)}`}
              control={<Input value={path} onChange={(event) => setPath(event.target.value)} />}
            />
            <SettingBlock
              label="Stack"
              cli={`orch project set ${shellQuote(project.name)} --stack ${shellQuote(stack)}`}
              control={<Input value={stack} onChange={(event) => setStack(event.target.value)} />}
            />
            <SettingBlock
              label="Canon ratio"
              cli={`orch project set ${shellQuote(project.name)} ${canon ? '--canon' : '--no-canon'}`}
              control={
                <label htmlFor="project-canon" className="flex items-center gap-2">
                  <Checkbox
                    id="project-canon"
                    checked={canon}
                    onChange={(event) => setCanon(event.target.checked)}
                  />
                  Counts toward canon ratio
                </label>
              }
            />
            <SettingBlock
              label="Trunk"
              cli={settingsCommand(project.name, { trunk })}
              control={<Input value={trunk} onChange={(event) => setTrunk(event.target.value)} />}
            />
            <SettingBlock
              label="Key prefixes"
              cli={settingsCommand(project.name, { keyPrefixes: prefixes })}
              control={
                <Input
                  value={keyPrefixes}
                  onChange={(event) => setKeyPrefixes(event.target.value)}
                  placeholder="DEV, HUB"
                />
              }
            />
            <SettingBlock
              label="Color"
              cli={settingsCommand(project.name, { color })}
              control={<Input value={color} onChange={(event) => setColor(event.target.value)} />}
            />
            <SettingBlock
              label="Color dark"
              cli={settingsCommand(project.name, { colorDark })}
              control={
                <Input value={colorDark} onChange={(event) => setColorDark(event.target.value)} />
              }
            />
          </div>
        </FieldSection>
        <FieldSection
          title="Context"
          description={`Whether ${PLATFORM_NAME} stores, lints, hydrates and injects this project's agent context.`}
        >
          <div className="space-y-5">
            <SettingBlock
              label="Managed context"
              cli={settingsCommand(project.name, { managedContext })}
              control={
                <label htmlFor="project-managed-context" className="flex items-center gap-2">
                  <Checkbox
                    id="project-managed-context"
                    checked={managedContext}
                    onChange={(event) => setManagedContext(event.target.checked)}
                  />
                  Managed by {PLATFORM_NAME}
                </label>
              }
            />
          </div>
        </FieldSection>
        <FieldSection
          title="Integrations"
          description="Tracker and worktree definitions are JSON in the project register."
        >
          <div className="space-y-5">
            <SettingBlock
              label="Tracker"
              cli={settingsCommand(project.name, { tracker: trackerCommandValue })}
              control={
                <Textarea
                  rows={12}
                  code
                  value={tracker}
                  onChange={(event) => setTracker(event.target.value)}
                />
              }
            />
            <SettingBlock
              label="Worktree"
              cli={settingsCommand(project.name, { worktree: worktreeCommandValue })}
              control={
                <Textarea
                  rows={12}
                  code
                  value={worktree}
                  onChange={(event) => setWorktree(event.target.value)}
                />
              }
            />
          </div>
        </FieldSection>
        {error ? (
          <p data-tone="error" className="text-status-text">
            {error} Correct the field and try again.
          </p>
        ) : null}
      </form>
    </Sheet>
  )
}
