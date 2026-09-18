import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { DEFAULT_ZONE, TIME_ZONES, WEEKDAYS, type Weekday } from '@/lib/report-arrival'
import { queryClient, type RecordSettingsResponse, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Checkbox } from '@/ui/checkbox/checkbox'
import { Dialog } from '@/ui/dialog/dialog'
import { EmptyState } from '@/ui/empty-state/empty-state'
import { Select } from '@/ui/listbox/select'
import { PageHeader, SectionTitle } from '@/ui/page-header/page-header'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table/table'

type Settings = RecordSettingsResponse
type Subscription = Settings['subscriptions'][number]
type Member = Settings['members'][number]
type Draft = {
  scope: string
  cadence: 'daily' | 'weekly'
  hour: number
  weekday: Weekday
  zone: string
  enabled: boolean
  recipientUserIds: string[]
}

export const Route = createFileRoute('/settings')({ component: SettingsPage })
const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.record.settings.queryKey() })

function SubscriptionDialog({
  row,
  projects,
  members,
  onClose,
}: {
  row?: Subscription
  projects: string[]
  members: Member[]
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Draft>({
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
    recipientUserIds: row?.recipients.map((recipient) => recipient.user_id) ?? [],
  })
  const create = useMutation({
    ...trpc.record.createReportSubscription.mutationOptions(),
    onSuccess: async () => {
      await refresh()
      onClose()
    },
  })
  const update = useMutation({
    ...trpc.record.updateReportSubscription.mutationOptions(),
    onSuccess: async () => {
      await refresh()
      onClose()
    },
  })
  const change = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
  const save = () => {
    const cadence = {
      cadence: draft.cadence,
      hour: draft.hour,
      weekday: draft.cadence === 'weekly' ? draft.weekday : null,
      zone: draft.zone,
      enabled: draft.enabled,
    }
    if (row) return update.mutate({ id: row.id, ...cadence })
    const scope = draft.scope.startsWith('project:')
      ? ({ kind: 'project', project: draft.scope.slice('project:'.length) } as const)
      : draft.scope === 'person'
        ? ({ kind: 'person' } as const)
        : ({ kind: 'space' } as const)
    create.mutate({ ...cadence, scope, recipientUserIds: draft.recipientUserIds })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={row ? 'Edit subscription' : 'Create subscription'}
      description={row ? 'Change its schedule.' : 'Choose a schedule and space members.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={create.isPending || update.isPending || (!row && !draft.recipientUserIds.length)}
            onClick={save}
          >
            {row ? 'Save changes' : 'Create subscription'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {!row ? (
          <>
            <Select
              label="Subscription scope"
              value={draft.scope}
              options={[
                { value: 'space', label: 'This space' },
                { value: 'person', label: 'My work in this space' },
                ...projects.map((project) => ({ value: `project:${project}`, label: project })),
              ]}
              onChange={(scope) => change({ scope })}
            />
            <div className="grid gap-2">
              <span className="text-sm text-text-muted">Recipients</span>
              {members.map((member) => (
                <label key={member.user_id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.recipientUserIds.includes(member.user_id)}
                    onChange={(event) =>
                      change({
                        recipientUserIds: event.target.checked
                          ? [...draft.recipientUserIds, member.user_id]
                          : draft.recipientUserIds.filter((id) => id !== member.user_id),
                      })
                    }
                  />
                  {member.name} ({member.email})
                </label>
              ))}
            </div>
          </>
        ) : null}
        <Select
          label="Report cadence"
          value={draft.cadence}
          options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]}
          onChange={(cadence) => change({ cadence: cadence as Draft['cadence'] })}
        />
        {draft.cadence === 'weekly' ? (
          <Select
            label="Report weekday"
            value={draft.weekday}
            options={WEEKDAYS.map((day) => ({ value: day, label: day }))}
            onChange={(weekday) => change({ weekday: weekday as Weekday })}
          />
        ) : null}
        <Select
          label="Report hour"
          value={String(draft.hour)}
          options={Array.from({ length: 24 }, (_, hour) => ({
            value: String(hour),
            label: `${String(hour).padStart(2, '0')}:00`,
          }))}
          onChange={(hour) => change({ hour: Number(hour) })}
        />
        <Select
          label="Report time zone"
          value={draft.zone}
          options={TIME_ZONES.map((zone) => ({ value: zone, label: zone }))}
          onChange={(zone) => change({ zone })}
        />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.enabled}
            onChange={(event) => change({ enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>
    </Dialog>
  )
}

function Recipients({ row, members }: { row: Subscription; members: Member[] }) {
  const [selected, setSelected] = useState('')
  const add = useMutation({
    ...trpc.record.addReportSubscriptionRecipient.mutationOptions(),
    onSuccess: async () => {
      setSelected('')
      await refresh()
    },
  })
  const remove = useMutation({
    ...trpc.record.removeReportSubscriptionRecipient.mutationOptions(),
    onSuccess: refresh,
  })
  const available = members.filter(
    (member) => !row.recipients.some((recipient) => recipient.user_id === member.user_id),
  )
  return (
    <div className="grid gap-2">
      {row.recipients.map((recipient) => (
        <div key={recipient.user_id} className="flex items-center justify-between gap-2">
          <span>{recipient.name} ({recipient.email})</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ id: row.id, userId: recipient.user_id })}
          >
            Remove
          </Button>
        </div>
      ))}
      {!row.recipients.length ? (
        <p className="text-status-text">No recipients; this subscription is not due.</p>
      ) : null}
      {available.length ? (
        <div className="flex gap-2">
          <Select
            label="Add recipient"
            value={selected}
            options={[
              { value: '', label: 'Add member…' },
              ...available.map((member) => ({ value: member.user_id, label: member.name })),
            ]}
            onChange={setSelected}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!selected || add.isPending}
            onClick={() => add.mutate({ id: row.id, userId: selected })}
          >
            Add
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function SettingsPage() {
  const query = useQuery(trpc.record.settings.queryOptions({ hours: 48 }, { refetchInterval: 10_000 }))
  const data = query.data
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Subscription>()
  const remove = useMutation({
    ...trpc.record.removeReportSubscription.mutationOptions(),
    onSuccess: refresh,
  })
  return (
    <section>
      <PageHeader title="Report subscriptions" subtitle="Schedules and delivery history" />
      {query.error ? <p className="text-status-text">could not load: {query.error.message}</p> : null}
      {data ? (
        <>
          <div className="flex max-w-[800px] items-center justify-between">
            <SectionTitle>Subscriptions</SectionTitle>
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Create subscription
            </Button>
          </div>
          <div className="mb-6 max-w-[800px] border border-border-default">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scope</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.subscriptions.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      {row.scope_kind === 'project' ? `project ${row.project_name}` : row.scope_kind}
                    </TableCell>
                    <TableCell muted>
                      {row.cadence === 'weekly'
                        ? `weekly ${row.weekday} ${row.hour}:00 ${row.zone}`
                        : `daily ${row.hour}:00 ${row.zone}`}
                      <Badge className="mt-1 block" tone={row.enabled ? 'success' : 'neutral'}>
                        {row.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell><Recipients row={row} members={data.members} /></TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(row)}>Edit</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate({ id: row.id })}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!data.subscriptions.length ? (
              <EmptyState title="No report subscriptions." hint="Create one for this space." />
            ) : null}
          </div>
          {(creating || editing) ? (
            <SubscriptionDialog
              row={editing}
              projects={data.allProjects}
              members={data.members}
              onClose={() => {
                setCreating(false)
                setEditing(undefined)
              }}
            />
          ) : null}
          <div className="max-w-[800px]"><SectionTitle>Send history</SectionTitle></div>
          <div className="max-w-[800px] border border-border-default">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead numeric>Items</TableHead>
                  <TableHead>Recipients</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sends.map((row) => (
                  <TableRow key={`${row.at}:${row.recipients}`}>
                    <TableCell muted>{row.at.slice(0, 16).replace('T', ' ')}</TableCell>
                    <TableCell><Badge>{String(row.status)}</Badge></TableCell>
                    <TableCell numeric>{row.items.toLocaleString()}</TableCell>
                    <TableCell muted>
                      {row.error
                        ? `Reason: ${row.error}`
                        : row.recipient_details
                            .map((recipient) => `${recipient.name} (${recipient.email})`)
                            .join(', ') || row.recipients}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!data.sends.length ? (
              <EmptyState title="No reports have been sent." hint="No send records exist for this space." />
            ) : null}
          </div>
        </>
      ) : query.isPending ? <p className="text-text-muted">Loading settings...</p> : null}
    </section>
  )
}
