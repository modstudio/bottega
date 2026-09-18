import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import { isHostedMode } from '@/lib/hub-mode'
import {
  DEFAULT_ZONE,
  nextReportArrival,
  TIME_ZONES,
  WEEKDAYS,
  type Weekday,
} from '@/lib/report-arrival'
import { useWindowState } from '@/lib/window'
import {
  queryClient,
  type RecordSettingsResponse,
  type SettingsResponse,
  trpc,
} from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Checkbox } from '@/ui/checkbox/checkbox'
import { Dialog } from '@/ui/dialog/dialog'
import { EmptyState } from '@/ui/empty-state/empty-state'
import { Input } from '@/ui/field/input'
import { FieldSection, Panel, SettingBlock } from '@/ui/form-layout/form-layout'
import { Select } from '@/ui/listbox/select'
import { PageHeader, SectionTitle } from '@/ui/page-header/page-header'
import { Switch } from '@/ui/switch/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table/table'

type SettingsData = SettingsResponse['data']
type Report = SettingsData['report']
type Subscription = RecordSettingsResponse['subscriptions'][number]
type FormState = {
  enabled: boolean
  to: string
  subjectPrefix: string
  fromName: string
  fromAddress: string
  windowHours: string
  minMinutes: string
  testTo: string
  projects: string[]
}

function formFrom(report: Report): FormState {
  return {
    enabled: report.enabled,
    to: report.to.join(', '),
    subjectPrefix: report.subjectPrefix,
    fromName: report.fromName,
    fromAddress: report.fromAddress,
    windowHours: String(report.windowHours),
    minMinutes: String(report.minMinutes),
    testTo: report.testTo,
    projects: report.projects,
  }
}

export const Route = createFileRoute('/settings')({ component: SettingsPage })

function SettingsPage() {
  return isHostedMode() ? <HostedSettingsPage /> : <LocalSettingsPage />
}

function LocalSettingsPage() {
  const { hours } = useWindowState()
  const query = useQuery(trpc.settings.get.queryOptions({ hours }, { refetchInterval: 10_000 }))
  const payload = query.data
  const data = payload?.data
  const [form, setForm] = useState<FormState | null>(null)
  const [dirty, setDirty] = useState(false)
  const [said, setSaid] = useState('')

  useEffect(() => {
    if (data && !dirty) setForm(formFrom(data.report))
  }, [data, dirty])

  const save = useMutation({
    ...trpc.settings.save.mutationOptions(),
    onSuccess: async (result) => {
      setForm(formFrom(result.report))
      setDirty(false)
      setSaid('saved')
      await queryClient.invalidateQueries()
    },
    onError: (error) => setSaid(`refused: ${error.message}`),
  })
  const sendTest = useMutation({
    ...trpc.settings.sendTest.mutationOptions(),
    onSuccess: (result) => setSaid(`test sent to ${result.to.join(', ')} (${result.items} tasks)`),
    onError: (error) => setSaid(`test failed: ${error.message}`),
  })
  const collect = useMutation({
    ...trpc.settings.collect.mutationOptions(),
    onSuccess: async () => {
      setSaid('collected')
      await queryClient.invalidateQueries()
    },
    onError: (error) => setSaid(`collect failed: ${error.message}`),
  })

  function change(patch: Partial<FormState>) {
    setForm((current) => (current ? { ...current, ...patch } : current))
    setDirty(true)
  }

  function submit() {
    if (!form) return
    setSaid('saving')
    save.mutate({
      enabled: form.enabled,
      to: form.to
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      subjectPrefix: form.subjectPrefix,
      fromName: form.fromName,
      fromAddress: form.fromAddress,
      windowHours: Number(form.windowHours) || 24,
      minMinutes: Number(form.minMinutes) || 0,
      testTo: form.testTo,
      projects: form.projects,
    })
  }

  function test() {
    setSaid('sending a test (the summary takes about a minute)')
    sendTest.mutate()
  }

  return (
    <section>
      <PageHeader
        title="Daily report"
        subtitle={
          data
            ? `Over the last ${data.report.windowHours}h: ${data.preview.items} tasks, ${data.preview.engaged} engaged`
            : 'Loading settings...'
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={collect.isPending}
            onClick={() => collect.mutate()}
          >
            {collect.isPending ? 'Collecting...' : 'Refresh data'}
          </Button>
        }
      />

      {query.error ? (
        <p data-tone="error" className="text-status-text">
          could not load: {query.error.message}
        </p>
      ) : null}
      {data && form ? (
        <>
          <Panel className="mb-6 max-w-[640px]">
            <div className="space-y-4">
              <FieldSection
                title="Schedule and delivery"
                description="What the daily report sends, and where it goes."
              >
                <label
                  htmlFor="report-enabled"
                  className="flex items-center gap-2 text-sm font-semibold"
                >
                  <Checkbox
                    id="report-enabled"
                    checked={form.enabled}
                    onChange={(event) => change({ enabled: event.target.checked })}
                  />
                  Send daily report
                  <span className="font-normal text-text-muted">
                    Off records why a send did not happen.
                  </span>
                </label>
                <div className="grid gap-4 md:grid-cols-2">
                  <SettingBlock
                    label="Recipients"
                    hint="Comma separated."
                    control={
                      <Input
                        value={form.to}
                        onChange={(event) => change({ to: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="Subject prefix"
                    control={
                      <Input
                        value={form.subjectPrefix}
                        onChange={(event) => change({ subjectPrefix: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="From name"
                    control={
                      <Input
                        value={form.fromName}
                        onChange={(event) => change({ fromName: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="From address"
                    control={
                      <Input
                        value={form.fromAddress}
                        onChange={(event) => change({ fromAddress: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="Window (hours)"
                    control={
                      <Input
                        value={form.windowHours}
                        onChange={(event) => change({ windowHours: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="Floor (minutes engaged)"
                    hint="Work below this floor is not sent."
                    control={
                      <Input
                        value={form.minMinutes}
                        onChange={(event) => change({ minMinutes: event.target.value })}
                      />
                    }
                  />
                  <SettingBlock
                    label="Test address"
                    hint="Tests go here without changing the recipient list."
                    control={
                      <Input
                        value={form.testTo}
                        onChange={(event) => change({ testTo: event.target.value })}
                      />
                    }
                  />
                </div>
                <div>
                  <div className="mb-2 text-sm text-text-muted">Projects in the email</div>
                  <div className="flex flex-wrap gap-4">
                    {data.allProjects.map((project) => (
                      <label
                        key={project}
                        htmlFor={`report-project-${project}`}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          id={`report-project-${project}`}
                          checked={form.projects.includes(project)}
                          onChange={(event) =>
                            change({
                              projects: event.target.checked
                                ? [...form.projects, project]
                                : form.projects.filter((name) => name !== project),
                            })
                          }
                        />
                        {project}
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-text-muted">
                    The dashboard always includes every registered project; the email is a subset,
                    which is the whole reason this is a setting.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="sm" disabled={save.isPending} onClick={submit}>
                    Save changes
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={sendTest.isPending}
                    onClick={test}
                  >
                    Send a test
                  </Button>
                  <span className="text-sm text-text-muted">{said}</span>
                </div>
              </FieldSection>
            </div>
          </Panel>

          <div className="max-w-[640px]">
            <SectionTitle
              detail={`${data.report.smtpUser} via ${data.report.smtpHost}:${data.report.smtpPort}`}
            >
              Delivery
            </SectionTitle>
          </div>
          <Panel className="mb-6 max-w-[640px]">
            <div>
              <div className="text-sm">
                <Badge tone={data.secrets.smtpPassword.resolves ? 'success' : 'error'}>
                  {data.secrets.smtpPassword.resolves ? 'password resolves' : 'password missing'}
                </Badge>{' '}
                <span className="text-text-muted">from {data.secrets.smtpPassword.ref}</span>
              </div>
              <p className="mt-3 max-w-3xl text-sm text-text-muted">
                No secret is stored in hub.db. This holds a reference; the password stays in the
                login keychain, and the page is only ever told whether it resolves.
              </p>
            </div>
          </Panel>

          <div className="max-w-[640px]">
            <SectionTitle>Recent sends</SectionTitle>
          </div>
          <div className="mb-6 max-w-[640px] border border-border-default">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead numeric>Items</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sends.length
                  ? data.sends.map((row) => (
                      <TableRow key={`${row.at}:${row.recipients}`}>
                        <TableCell muted>{row.at.slice(0, 16).replace('T', ' ')}</TableCell>
                        <TableCell>
                          <Badge tone={row.status === 'failed' ? 'error' : 'neutral'}>
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell numeric>{row.items.toLocaleString()}</TableCell>
                        <TableCell muted>
                          {row.test ? <Badge className="mr-2">test</Badge> : null}
                          {row.error || row.recipients}
                        </TableCell>
                      </TableRow>
                    ))
                  : null}
              </TableBody>
            </Table>
            {!data.sends.length ? (
              <EmptyState
                title="No reports have been sent."
                hint="Send a test or enable delivery to create a send record."
              />
            ) : null}
          </div>

          <div className="max-w-[640px]">
            <SectionTitle
              detail={
                data.register.length ? `${data.register.length} registered` : 'None registered'
              }
            >
              Projects
            </SectionTitle>
          </div>
          <Panel className="max-w-[640px]">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-text-muted">
                Read only. Hub cannot write the orchestrator register.
              </p>
              <Button size="sm" render={<Link to="/projects" />}>
                View projects
              </Button>
            </div>
          </Panel>
        </>
      ) : null}
    </section>
  )
}

type SubscriptionDraft = {
  scope: string
  cadence: Subscription['cadence']
  hour: number
  weekday: Weekday
  zone: string
  enabled: boolean
}

function subscriptionDraft(row?: Subscription): SubscriptionDraft {
  return {
    scope: row
      ? row.scope_kind === 'project'
        ? `project:${row.project_name}`
        : row.scope_kind
      : 'space',
    cadence: row?.cadence ?? 'daily',
    hour: row?.hour ?? 9,
    weekday: row?.weekday ?? 'monday',
    zone: row?.zone ?? DEFAULT_ZONE,
    enabled: row?.enabled ?? true,
  }
}

function SubscriptionEditor({
  open,
  row,
  projects,
  pending,
  onOpenChange,
  onSave,
}: {
  open: boolean
  row?: Subscription
  projects: string[]
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSave: (draft: SubscriptionDraft) => void
}) {
  const [draft, setDraft] = useState(() => subscriptionDraft(row))
  const enabledId = useId()
  useEffect(() => {
    if (open) setDraft(subscriptionDraft(row))
  }, [open, row])
  const change = (patch: Partial<SubscriptionDraft>) =>
    setDraft((current) => ({ ...current, ...patch }))
  const scopeOptions = [
    { value: 'space', label: 'This space' },
    { value: 'person', label: 'My work in this space' },
    ...projects.map((project) => ({ value: `project:${project}`, label: `Project ${project}` })),
  ]
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={row ? 'Edit subscription' : 'Create subscription'}
      description={
        row
          ? `${row.recipient_email} · scope and recipient stay fixed`
          : 'Reports are sent to you in the current space.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => onSave(draft)}>
            {row ? 'Save changes' : 'Create subscription'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {!row ? (
          <div className="grid gap-1 text-sm">
            <span className="text-text-muted">Scope</span>
            <Select
              label="Subscription scope"
              value={draft.scope}
              options={scopeOptions}
              onChange={(scope) => change({ scope })}
            />
          </div>
        ) : null}
        <div className="grid gap-1 text-sm">
          <span className="text-text-muted">Cadence</span>
          <Select
            label="Report cadence"
            value={draft.cadence}
            options={[
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
            ]}
            onChange={(cadence) => change({ cadence: cadence as Subscription['cadence'] })}
          />
        </div>
        {draft.cadence === 'weekly' ? (
          <div className="grid gap-1 text-sm">
            <span className="text-text-muted">Weekday</span>
            <Select
              label="Report weekday"
              value={draft.weekday}
              options={WEEKDAYS.map((weekday) => ({
                value: weekday,
                label: weekday[0]!.toUpperCase() + weekday.slice(1),
              }))}
              onChange={(weekday) => change({ weekday: weekday as Weekday })}
            />
          </div>
        ) : null}
        <div className="grid gap-1 text-sm">
          <span className="text-text-muted">Hour</span>
          <Select
            label="Report hour"
            value={String(draft.hour)}
            options={Array.from({ length: 24 }, (_, hour) => ({
              value: String(hour),
              label: `${String(hour).padStart(2, '0')}:00`,
            }))}
            onChange={(hour) => change({ hour: Number(hour) })}
          />
        </div>
        <div className="grid gap-1 text-sm">
          <span className="text-text-muted">Time zone</span>
          <Select
            label="Report time zone"
            value={draft.zone}
            options={TIME_ZONES.map((zone) => ({ value: zone, label: zone }))}
            onChange={(zone) => change({ zone })}
          />
        </div>
        <p className="text-sm text-text-secondary">
          {nextReportArrival({
            cadence: draft.cadence,
            hour: draft.hour,
            weekday: draft.cadence === 'weekly' ? draft.weekday : null,
            zone: draft.zone,
          })}
        </p>
        <label htmlFor={enabledId} className="flex items-center gap-3 text-sm">
          <Switch
            id={enabledId}
            checked={draft.enabled}
            onChange={(event) => change({ enabled: event.currentTarget.checked })}
          />
          Enabled
        </label>
      </div>
    </Dialog>
  )
}

export function HostedSettingsPage() {
  const { hours } = useWindowState()
  const query = useQuery(trpc.record.settings.queryOptions({ hours }, { refetchInterval: 10_000 }))
  const data = query.data
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Subscription | undefined>()
  const [said, setSaid] = useState('')
  const create = useMutation({
    ...trpc.record.createReportSubscription.mutationOptions(),
    onSuccess: async () => {
      setCreating(false)
      setSaid('Subscription created.')
      await queryClient.invalidateQueries({ queryKey: trpc.record.settings.queryKey() })
    },
    onError: (error) => setSaid(`Could not create subscription: ${error.message}`),
  })
  const update = useMutation({
    ...trpc.record.updateReportSubscription.mutationOptions(),
    onSuccess: async () => {
      setEditing(undefined)
      setSaid('Subscription updated.')
      await queryClient.invalidateQueries({ queryKey: trpc.record.settings.queryKey() })
    },
    onError: (error) => setSaid(`Could not update subscription: ${error.message}`),
  })
  const remove = useMutation({
    ...trpc.record.removeReportSubscription.mutationOptions(),
    onSuccess: async () => {
      setSaid('Subscription removed.')
      await queryClient.invalidateQueries({ queryKey: trpc.record.settings.queryKey() })
    },
    onError: (error) => setSaid(`Could not remove subscription: ${error.message}`),
  })
  const display = (value: unknown) =>
    Array.isArray(value)
      ? value.join(', ') || '-'
      : typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : String(value ?? '-')
  return (
    <section>
      <PageHeader title="Daily report" subtitle="Hosted report settings" />
      {query.error ? (
        <p data-tone="error" className="text-status-text">
          could not load: {query.error.message}
        </p>
      ) : null}
      {data ? (
        <>
          <div className="max-w-[640px]">
            <SectionTitle>Stored values</SectionTitle>
          </div>
          <Panel className="mb-6 max-w-[640px]">
            <dl className="grid gap-3 md:grid-cols-2">
              {Object.entries(data.report).map(([name, value]) => (
                <div key={name}>
                  <dt className="text-xs text-text-muted">{name}</dt>
                  <dd className="break-words text-sm">
                    {name === 'smtpPasswordRef'
                      ? data.secrets.smtpPassword.configured
                        ? 'Reference stored; resolution unavailable on hosted server'
                        : 'No reference stored; resolution unavailable on hosted server'
                      : display(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
          <div className="flex max-w-[640px] items-center justify-between gap-4">
            <SectionTitle>Subscriptions</SectionTitle>
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Create subscription
            </Button>
          </div>
          {said ? <p className="mb-3 max-w-[640px] text-sm text-text-secondary">{said}</p> : null}
          <div className="mb-6 max-w-[640px] border border-border-default">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scope</TableHead>
                  <TableHead>Cadence</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.subscriptions.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      {row.scope_kind === 'project'
                        ? `project ${row.project_name}`
                        : row.scope_kind === 'person'
                          ? `person ${row.person_user_id}`
                          : 'space'}
                    </TableCell>
                    <TableCell muted>
                      <span>
                        {row.cadence === 'weekly'
                          ? `weekly ${row.weekday} ${row.hour}:00 ${row.zone}`
                          : `daily ${row.hour}:00 ${row.zone}`}
                      </span>
                      <span className="mt-1 block text-xs">{nextReportArrival(row)}</span>
                    </TableCell>
                    <TableCell>{row.recipient_email}</TableCell>
                    <TableCell>
                      <Badge tone={row.enabled ? 'success' : 'neutral'}>
                        {row.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(row)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate({ id: row.id })}
                        >
                          Remove
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!data.subscriptions.length ? (
              <EmptyState
                title="No report subscriptions."
                hint="No subscriptions exist for this space."
              />
            ) : null}
          </div>
          <SubscriptionEditor
            open={creating}
            projects={data.allProjects}
            pending={create.isPending}
            onOpenChange={setCreating}
            onSave={(draft) => {
              const scope = draft.scope.startsWith('project:')
                ? ({ kind: 'project', project: draft.scope.slice('project:'.length) } as const)
                : draft.scope === 'person'
                  ? ({ kind: 'person' } as const)
                  : ({ kind: 'space' } as const)
              create.mutate({
                scope,
                cadence: draft.cadence,
                hour: draft.hour,
                weekday: draft.cadence === 'weekly' ? draft.weekday : null,
                zone: draft.zone,
                enabled: draft.enabled,
              })
            }}
          />
          {editing ? (
            <SubscriptionEditor
              open
              row={editing}
              projects={data.allProjects}
              pending={update.isPending}
              onOpenChange={(open) => !open && setEditing(undefined)}
              onSave={(draft) =>
                update.mutate({
                  id: editing.id,
                  cadence: draft.cadence,
                  hour: draft.hour,
                  weekday: draft.cadence === 'weekly' ? draft.weekday : null,
                  zone: draft.zone,
                  enabled: draft.enabled,
                })
              }
            />
          ) : null}
          <div className="max-w-[640px]">
            <SectionTitle>Recent sends</SectionTitle>
          </div>
          <div className="mb-6 max-w-[640px] border border-border-default">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead numeric>Items</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sends.map((row) => (
                  <TableRow key={`${row.at}:${row.recipients}`}>
                    <TableCell muted>{row.at.slice(0, 16).replace('T', ' ')}</TableCell>
                    <TableCell>
                      <Badge
                        tone={
                          row.status === 'failed'
                            ? 'error'
                            : row.status === 'sent'
                              ? 'success'
                              : 'neutral'
                        }
                      >
                        {String(row.status)}
                      </Badge>
                    </TableCell>
                    <TableCell numeric>{row.items.toLocaleString()}</TableCell>
                    <TableCell muted>
                      {row.test ? <Badge className="mr-2">test</Badge> : null}
                      {row.error ? `Reason: ${row.error}` : String(row.recipients)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!data.sends.length ? (
              <EmptyState
                title="No reports have been sent."
                hint="No send records exist for this space."
              />
            ) : null}
          </div>
        </>
      ) : query.isPending ? (
        <p className="text-text-muted">Loading settings...</p>
      ) : null}
    </section>
  )
}
