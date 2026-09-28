import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { Plus, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Markdown } from '@/components/markdown'
import { isHostedMode } from '@/lib/hub-mode'
import { queryClient, trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { Textarea } from '@/ui/field/textarea'
import { Copyable, DisplayRow, FieldSection, SettingBlock } from '@/ui/form-layout/form-layout'
import { Select } from '@/ui/listbox/select'
import { PageHeader } from '@/ui/page-header/page-header'
import { RELEASE_AUTONOMY_VALUES } from '../../../../shared/release-autonomy'

export const Route = createFileRoute('/context')({
  component: () => (isHostedMode() ? <Navigate to="/" /> : <ManagedContextPage />),
})

const stageValues = [
  { value: 'ask', label: 'Ask' },
  { value: 'review', label: 'Review' },
  { value: 'auto', label: 'Auto' },
] as const

const releaseValues = RELEASE_AUTONOMY_VALUES.map((value) => ({
  value,
  label: `${value[0]!.toUpperCase()}${value.slice(1)}`,
}))

function ErrorText({ message }: { message: string }) {
  return (
    <p data-tone="error" className="whitespace-pre-wrap text-status-text">
      {message}
    </p>
  )
}

function Lines({ children }: { children: string }) {
  return <span className="whitespace-pre-wrap">{children}</span>
}

function RemoveCanonButton({
  hidden,
  disabled,
  onClick,
}: {
  hidden: boolean
  disabled: boolean
  onClick: () => void
}) {
  if (hidden) return null
  return (
    <Button variant="danger" disabled={disabled} onClick={onClick}>
      <Trash2 size={14} /> Remove
    </Button>
  )
}

export function ManagedContextPage() {
  const projects = useQuery(trpc.context.projects.queryOptions())
  const canon = useQuery(trpc.context.userCanon.list.queryOptions())
  const [projectChoice, setProjectChoice] = useState('')
  const [settingsChoice, setSettingsChoice] = useState('user')
  const selectedProject = projectChoice || projects.data?.[0]?.name || ''
  const managedProjects = projects.data?.filter((project) => project.managedContext) ?? []
  const projectOptions = (projects.data ?? []).map((project) => ({
    value: project.name,
    label: project.name,
  }))
  const settingsOptions = [
    { value: 'user', label: 'User' },
    ...managedProjects.map((project) => ({ value: project.name, label: project.name })),
  ]

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-5 pb-12">
      <PageHeader title="Managed context" subtitle="User canon, autonomy, and managed settings" />
      <UserCanonSection rows={canon.data} pending={canon.isPending} error={canon.error?.message} />
      <AutonomySection
        project={selectedProject}
        options={projectOptions}
        onProject={setProjectChoice}
      />
      <ManagedSettingsSection
        target={settingsChoice}
        options={settingsOptions}
        projects={managedProjects}
        onTarget={setSettingsChoice}
      />
    </div>
  )
}

type CanonRows = Array<{
  slug: string
  title: string
  body: string
  revision: string | null
  updated_at: string
}>

export function UserCanonSection({
  rows,
  pending,
  error,
}: {
  rows: CanonRows | undefined
  pending: boolean
  error?: string
}) {
  const [choice, setChoice] = useState('')
  const [creating, setCreating] = useState(false)
  const selected = choice || rows?.[0]?.slug || ''
  const detail = useQuery({
    ...trpc.context.userCanon.get.queryOptions({ slug: selected || '_' }),
    enabled: Boolean(selected),
  })
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (!detail.data || creating) return
    setSlug(detail.data.slug)
    setTitle(detail.data.title)
    setBody(detail.data.body)
  }, [detail.data, creating])

  const save = useMutation(
    trpc.context.userCanon.set.mutationOptions({
      onSuccess: async (row) => {
        await queryClient.invalidateQueries({ queryKey: trpc.context.userCanon.pathKey() })
        setChoice(row.slug)
        setCreating(false)
        setReason('')
      },
    }),
  )
  const remove = useMutation(
    trpc.context.userCanon.remove.mutationOptions({
      onSuccess: async () => {
        setChoice('')
        setReason('')
        await queryClient.invalidateQueries({ queryKey: trpc.context.userCanon.pathKey() })
      },
    }),
  )

  const beginCreate = () => {
    setCreating(true)
    setSlug('')
    setTitle('')
    setBody('')
    setReason('')
  }

  return (
    <FieldSection title="User canon" description="Canon owned by the signed-in operator.">
      {pending ? <p className="text-text-muted">Loading user canon…</p> : null}
      {error ? <ErrorText message={error} /> : null}
      {!pending && !error && rows?.length === 0 ? <p className="text-text-muted">No rows</p> : null}
      {!error ? (
        <div className="grid gap-5 md:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="space-y-2">
            {rows?.map((row) => (
              <Button
                key={row.slug}
                variant={selected === row.slug && !creating ? 'primary' : 'secondary'}
                onClick={() => {
                  setCreating(false)
                  setChoice(row.slug)
                }}
              >
                {row.slug} · {new TextEncoder().encode(row.body).length} bytes · {row.updated_at}
              </Button>
            ))}
            <Button variant="secondary" onClick={beginCreate}>
              <Plus size={14} /> Create row
            </Button>
          </div>
          {creating || detail.data ? (
            <div className="space-y-3">
              <Input
                aria-label="Slug"
                placeholder="Slug"
                value={slug}
                disabled={!creating}
                onChange={(event) => setSlug(event.target.value)}
              />
              <Input
                aria-label="Title"
                placeholder="Title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <div className="grid grid-cols-2 divide-x divide-border border border-border-default">
                <Textarea
                  aria-label="Canon markdown"
                  code
                  bare
                  className="min-h-80"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                />
                <div className="min-h-80 overflow-auto p-3">
                  <Markdown content={body} />
                </div>
              </div>
              <Input
                aria-label="Canon reason"
                placeholder="Reason (required)"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              {save.error ? <ErrorText message={save.error.message} /> : null}
              {remove.error ? <ErrorText message={remove.error.message} /> : null}
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={!slug.trim() || !title.trim() || !reason.trim() || save.isPending}
                  onClick={() =>
                    save.mutate({
                      slug,
                      title,
                      body,
                      reason,
                      expectedRevision: creating ? undefined : (detail.data?.revision ?? undefined),
                    })
                  }
                >
                  <Save size={14} /> Save
                </Button>
                <RemoveCanonButton
                  hidden={creating}
                  disabled={!reason.trim() || remove.isPending}
                  onClick={() =>
                    remove.mutate({
                      slug,
                      reason,
                      expectedRevision: detail.data?.revision ?? undefined,
                    })
                  }
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </FieldSection>
  )
}

function AutonomySection({
  project,
  options,
  onProject,
}: {
  project: string
  options: { value: string; label: string }[]
  onProject(value: string): void
}) {
  const autonomy = useQuery({
    ...trpc.context.autonomy.get.queryOptions({ project: project || '_' }),
    enabled: Boolean(project),
  })
  const update = useMutation(
    trpc.context.autonomy.set.mutationOptions({
      onSuccess: (data) =>
        queryClient.setQueryData(
          trpc.context.autonomy.get.queryOptions({ project }).queryKey,
          data,
        ),
    }),
  )
  const updateRelease = useMutation(
    trpc.context.autonomy.setRelease.mutationOptions({
      onSuccess: (data) =>
        queryClient.setQueryData(
          trpc.context.autonomy.get.queryOptions({ project }).queryKey,
          data,
        ),
    }),
  )
  const releaseLine = autonomy.data?.registered
    ? autonomy.data.text.split('\n').find((line) => line.startsWith('release: '))
    : undefined
  return (
    <FieldSection
      title="Autonomy"
      description="Resolved workflow stage values and the scope that set each one."
    >
      <Select label="Project" value={project} options={options} onChange={onProject} />
      {autonomy.error ? <ErrorText message={autonomy.error.message} /> : null}
      {update.error ? <ErrorText message={update.error.message} /> : null}
      {updateRelease.error ? <ErrorText message={updateRelease.error.message} /> : null}
      {autonomy.data?.registered ? (
        <div className="space-y-3">
          <DisplayRow
            label="Rulings"
            value={`${autonomy.data.rulings.value} · ${autonomy.data.rulings.scope}`}
          />
          <SettingBlock
            label="release"
            hint={releaseLine ?? `release: ${autonomy.data.release.value}`}
            control={
              <Select
                label="release autonomy"
                value={autonomy.data.release.value}
                options={releaseValues}
                onChange={(next) =>
                  updateRelease.mutate({
                    project,
                    value: next as 'push' | 'land' | 'promote',
                  })
                }
              />
            }
          />
          {autonomy.data.stages.map((stage) => {
            const value = stage.agreed ? stage.value : (stage.values[0]?.value ?? 'ask')
            const resolved = stage.agreed
              ? `${stage.value} · ${stage.scope}`
              : stage.values
                  .map((item) => `${item.value} (${item.steps} steps, ${item.scope})`)
                  .join('; ')
            return (
              <SettingBlock
                key={stage.stage}
                label={stage.stage}
                hint={`Resolved: ${resolved}`}
                control={
                  <Select
                    label={`${stage.stage} autonomy`}
                    value={value}
                    options={stageValues}
                    onChange={(next) =>
                      update.mutate({
                        project,
                        stage: stage.stage,
                        value: next as 'ask' | 'review' | 'auto',
                      })
                    }
                  />
                }
              />
            )
          })}
        </div>
      ) : null}
    </FieldSection>
  )
}

type ManagedProject = { name: string; worktreeNote: string | null }

function ManagedSettingsSection({
  target,
  options,
  projects,
  onTarget,
}: {
  target: string
  options: { value: string; label: string }[]
  projects: ManagedProject[]
  onTarget(value: string): void
}) {
  const address = target === 'user' ? ({ user: true } as const) : { project: target }
  const settings = useQuery(trpc.context.settings.get.queryOptions(address))
  const [list, setList] = useState<'allow' | 'ask' | 'deny'>('allow')
  const [rule, setRule] = useState('')
  const [reason, setReason] = useState('')
  const change = useMutation(
    trpc.context.settings.permission.mutationOptions({
      onSuccess: async () => {
        setRule('')
        setReason('')
        await queryClient.invalidateQueries({ queryKey: trpc.context.settings.pathKey() })
      },
    }),
  )
  const project = projects.find((row) => row.name === target)
  const apply =
    target === 'user'
      ? 'orch settings render --write --user --yes'
      : `orch settings render --write --project ${target} --yes${project?.worktreeNote ? `\n\nWorktree note:\n${project.worktreeNote}` : ''}`

  return (
    <FieldSection
      title="Managed settings"
      description="Stored permissions, hook fingerprints, environment names, and drift."
    >
      <Select label="Settings target" value={target} options={options} onChange={onTarget} />
      {settings.error ? <ErrorText message={settings.error.message} /> : null}
      {settings.data ? (
        <div className="space-y-5">
          <DisplayRow
            label="File"
            value={`${settings.data.file.exists ? 'exists' : 'missing'} · ${settings.data.file.path}`}
          />
          {(['allow', 'ask', 'deny'] as const).map((name) => (
            <DisplayRow
              key={name}
              label={`${name} (${settings.data.settings.permissions[name].length})`}
              value={<Lines>{settings.data.settings.permissions[name].join('\n') || '—'}</Lines>}
            />
          ))}
          <DisplayRow
            label={`Hooks (${settings.data.settings.hooks.length})`}
            value={
              <Lines>
                {settings.data.settings.hooks
                  .map((hook) => `${hook.event} · ${hook.matcher} · ${hook.fingerprint}`)
                  .join('\n') || '—'}
              </Lines>
            }
          />
          <DisplayRow
            label={`Environment keys (${settings.data.settings.envKeys.length})`}
            value={settings.data.settings.envKeys.join(', ') || '—'}
          />
          <DisplayRow label="Drift" value={<Lines>{driftText(settings.data.drift)}</Lines>} />
          {settings.data.findings.map((finding) => (
            <ErrorText
              key={`${finding.rule}-${finding.message}`}
              message={`${finding.rule}: ${finding.message}`}
            />
          ))}
          <div className="grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
            <Select
              label="Permission list"
              value={list}
              options={[
                { value: 'allow', label: 'Allow' },
                { value: 'ask', label: 'Ask' },
                { value: 'deny', label: 'Deny' },
              ]}
              onChange={(value) => setList(value as typeof list)}
            />
            <Input
              aria-label="Permission rule"
              placeholder="Permission rule"
              value={rule}
              onChange={(event) => setRule(event.target.value)}
            />
          </div>
          <Input
            aria-label="Settings reason"
            placeholder="Reason (required)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {change.error ? <ErrorText message={change.error.message} /> : null}
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={
                !settings.data.revision || !rule.trim() || !reason.trim() || change.isPending
              }
              onClick={() =>
                change.mutate({
                  target: address,
                  list,
                  rule,
                  operation: 'add',
                  reason,
                  expectedRevision: settings.data.revision ?? '',
                })
              }
            >
              Add rule
            </Button>
            <Button
              variant="danger"
              disabled={
                !settings.data.revision || !rule.trim() || !reason.trim() || change.isPending
              }
              onClick={() =>
                change.mutate({
                  target: address,
                  list,
                  rule,
                  operation: 'remove',
                  reason,
                  expectedRevision: settings.data.revision ?? '',
                })
              }
            >
              Remove rule
            </Button>
          </div>
          <SettingBlock
            label="Apply from a terminal"
            control={<Copyable value={apply} />}
            hint="This page does not write the real settings file."
          />
        </div>
      ) : null}
    </FieldSection>
  )
}

function driftText(drift: {
  rules: Record<'allow' | 'ask' | 'deny', { added: string[]; removed: string[] }>
  hooks: {
    added: { event: string; matcher: string; fingerprint: string }[]
    removed: { event: string; matcher: string; fingerprint: string }[]
  }
  envKeys: { added: string[]; removed: string[] }
}) {
  const lines: string[] = []
  for (const name of ['allow', 'ask', 'deny'] as const) {
    lines.push(...drift.rules[name].added.map((rule) => `added ${name}: ${rule}`))
    lines.push(...drift.rules[name].removed.map((rule) => `removed ${name}: ${rule}`))
  }
  lines.push(
    ...drift.hooks.added.map(
      (hook) => `added hook: ${hook.event} · ${hook.matcher} · ${hook.fingerprint}`,
    ),
  )
  lines.push(
    ...drift.hooks.removed.map(
      (hook) => `removed hook: ${hook.event} · ${hook.matcher} · ${hook.fingerprint}`,
    ),
  )
  lines.push(...drift.envKeys.added.map((name) => `added env key: ${name}`))
  lines.push(...drift.envKeys.removed.map((name) => `removed env key: ${name}`))
  return lines.join('\n') || 'No drift'
}
