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
import { Input } from '@/ui/field/input'
import { Select } from '@/ui/listbox/select'
import { PageHeader, SectionTitle } from '@/ui/page-header/page-header'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table/table'

type Settings = RecordSettingsResponse
type Subscription = Settings['subscriptions'][number]
type Member = Settings['members'][number]
type Draft = {
  scope: 'space' | 'project' | 'members'
  project: string
  memberUserIds: string[]
  cadence: 'daily' | 'weekly'
  hour: number
  weekday: Weekday
  zone: string
  enabled: boolean
  recipientUserIds: string[]
  recipientEmails: string[]
}

export const Route = createFileRoute('/settings')({ component: SettingsPage })
const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.record.settings.queryKey() })

function SubscriptionDialog({
  row,
  projects,
  members,
  canManageEmails,
  onClose,
}: {
  row?: Subscription
  projects: string[]
  members: Member[]
  canManageEmails: boolean
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Draft>({
    scope: row?.scope_kind ?? 'space',
    project: row?.project_name ?? projects[0] ?? '',
    memberUserIds: row?.members.map((member) => member.user_id) ?? [],
    cadence: row?.cadence ?? 'daily',
    hour: row?.hour ?? 9,
    weekday: row?.weekday ?? 'monday',
    zone: row?.zone ?? DEFAULT_ZONE,
    enabled: row?.enabled ?? true,
    recipientUserIds:
      row?.recipients.flatMap((recipient) => (recipient.user_id ? [recipient.user_id] : [])) ?? [],
    recipientEmails:
      row?.recipients
        .filter((recipient) => !recipient.user_id)
        .map((recipient) => recipient.email) ?? [],
  })
  const [email, setEmail] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [testMessage, setTestMessage] = useState('')
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
  const remove = useMutation({
    ...trpc.record.removeReportSubscription.mutationOptions(),
    onSuccess: async () => {
      await refresh()
      onClose()
    },
  })
  const sendTest = useMutation({
    ...trpc.record.sendReportSubscriptionTest.mutationOptions(),
    onSuccess: (result) => {
      setTestMessage(`Test sent to ${result.email}`)
      void refresh()
    },
    onError: (error) => setTestMessage(error.message),
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
    const scope =
      draft.scope === 'project'
        ? ({ kind: 'project', project: draft.project } as const)
        : draft.scope === 'members'
          ? ({ kind: 'members', userIds: draft.memberUserIds } as const)
          : ({ kind: 'space' } as const)
    const input = {
      ...cadence,
      scope,
      recipientUserIds: draft.recipientUserIds,
      recipientEmails: draft.recipientEmails,
    }
    if (row) return update.mutate({ id: row.id, ...input })
    create.mutate(input)
  }
  const pending = create.isPending || update.isPending || remove.isPending || sendTest.isPending
  const failure = create.error ?? update.error ?? remove.error
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={row ? 'Edit subscription' : 'Create subscription'}
      description="Choose what the report covers, when it is sent, and who receives it."
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {row ? (
              <>
                <Button
                  variant="danger"
                  disabled={pending}
                  onClick={() =>
                    confirmingDelete ? remove.mutate({ id: row.id }) : setConfirmingDelete(true)
                  }
                >
                  {confirmingDelete ? 'Confirm delete' : 'Delete'}
                </Button>
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setTestMessage('')
                    sendTest.mutate({ id: row.id })
                  }}
                >
                  Send test
                </Button>
                {testMessage ? (
                  <span className="text-sm text-text-muted">{testMessage}</span>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                pending ||
                (!draft.recipientUserIds.length && !draft.recipientEmails.length) ||
                (draft.scope === 'members' && !draft.memberUserIds.length)
              }
              onClick={save}
            >
              {row ? 'Save changes' : 'Create subscription'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-4">
        {failure ? <p className="text-sm text-status-text">{failure.message}</p> : null}
        <Select
          label="Report covers"
          value={draft.scope}
          options={[
            { value: 'space', label: 'Space' },
            { value: 'project', label: 'Project' },
            { value: 'members', label: 'Members' },
          ]}
          onChange={(scope) => change({ scope: scope as Draft['scope'] })}
        />
        {draft.scope === 'project' ? (
          <Select
            label="Project"
            value={draft.project}
            options={projects.map((project) => ({ value: project, label: project }))}
            onChange={(project) => change({ project })}
          />
        ) : null}
        {draft.scope === 'members' ? (
          <MemberChecks
            label="Members"
            prefix="scope-member"
            members={members}
            selected={draft.memberUserIds}
            onChange={(memberUserIds) => change({ memberUserIds })}
          />
        ) : null}
        <MemberChecks
          label="Recipients"
          prefix="recipient"
          members={members}
          selected={draft.recipientUserIds}
          onChange={(recipientUserIds) => change({ recipientUserIds })}
        />
        <div className="grid gap-2">
          <span className="text-sm text-text-muted">Email addresses</span>
          {canManageEmails ? (
            <div className="flex gap-2">
              <Input
                type="email"
                aria-label="Add email address"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Button
                variant="secondary"
                disabled={!email.trim()}
                onClick={() => {
                  const normalized = email.trim().toLowerCase()
                  if (normalized && !draft.recipientEmails.includes(normalized))
                    change({ recipientEmails: [...draft.recipientEmails, normalized] })
                  setEmail('')
                }}
              >
                Add
              </Button>
            </div>
          ) : null}
          {draft.recipientEmails.map((address) => (
            <div key={address} className="flex items-center gap-2 text-sm">
              <span>{address}</span>
              {canManageEmails ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    change({
                      recipientEmails: draft.recipientEmails.filter((value) => value !== address),
                    })
                  }
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        <Select
          label="Cadence"
          value={draft.cadence}
          options={[
            { value: 'daily', label: 'Daily' },
            { value: 'weekly', label: 'Weekly' },
          ]}
          onChange={(cadence) => change({ cadence: cadence as Draft['cadence'] })}
        />
        {draft.cadence === 'weekly' ? (
          <Select
            label="Weekday"
            value={draft.weekday}
            options={WEEKDAYS.map((day) => ({ value: day, label: day }))}
            onChange={(weekday) => change({ weekday: weekday as Weekday })}
          />
        ) : null}
        <Select
          label="Hour"
          value={String(draft.hour)}
          options={Array.from({ length: 24 }, (_, hour) => ({
            value: String(hour),
            label: `${String(hour).padStart(2, '0')}:00`,
          }))}
          onChange={(hour) => change({ hour: Number(hour) })}
        />
        <Select
          label="Time zone"
          value={draft.zone}
          options={TIME_ZONES.map((zone) => ({ value: zone, label: zone }))}
          onChange={(zone) => change({ zone })}
        />
        <label htmlFor="subscription-enabled" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="subscription-enabled"
            checked={draft.enabled}
            onChange={(event) => change({ enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>
    </Dialog>
  )
}

function MemberChecks({
  label,
  prefix,
  members,
  selected,
  onChange,
}: {
  label: string
  prefix: string
  members: Member[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  return (
    <div className="grid gap-2">
      <span className="text-sm text-text-muted">{label}</span>
      {members.map((member) => (
        <label
          key={member.user_id}
          htmlFor={`${prefix}-${member.user_id}`}
          className="flex items-center gap-2 text-sm"
        >
          <Checkbox
            id={`${prefix}-${member.user_id}`}
            checked={selected.includes(member.user_id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, member.user_id]
                  : selected.filter((id) => id !== member.user_id),
              )
            }
          />
          {member.name} ({member.email})
        </label>
      ))}
    </div>
  )
}

export function SettingsPage() {
  const query = useQuery(
    trpc.record.settings.queryOptions({ hours: 48 }, { refetchInterval: 10_000 }),
  )
  const data = query.data
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Subscription>()
  return (
    <section>
      <PageHeader title="Report subscriptions" subtitle="Schedules and delivery history" />
      {query.error ? (
        <p className="text-status-text">could not load: {query.error.message}</p>
      ) : null}
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
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.subscriptions.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      {row.scope_kind === 'project'
                        ? `Project: ${row.project_name}`
                        : row.scope_kind === 'members'
                          ? `Members: ${row.members.map((member) => member.name).join(', ')}`
                          : 'Space'}
                    </TableCell>
                    <TableCell muted>
                      {row.cadence === 'weekly'
                        ? `weekly ${row.weekday} ${row.hour}:00 ${row.zone}`
                        : `daily ${row.hour}:00 ${row.zone}`}
                      <Badge className="mt-1 block" tone={row.enabled ? 'success' : 'neutral'}>
                        {row.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {row.recipients
                        .map((recipient) => (recipient.user_id ? recipient.name : recipient.email))
                        .join(', ')}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="secondary" onClick={() => setEditing(row)}>
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!data.subscriptions.length ? (
              <EmptyState title="No report subscriptions." hint="Create one for this space." />
            ) : null}
          </div>
          {creating || editing ? (
            <SubscriptionDialog
              row={editing}
              projects={data.allProjects}
              members={data.members}
              canManageEmails={data.callerRole === 'owner' || data.callerRole === 'admin'}
              onClose={() => {
                setCreating(false)
                setEditing(undefined)
              }}
            />
          ) : null}
          <div className="max-w-[800px]">
            <SectionTitle>Send history</SectionTitle>
          </div>
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
                    <TableCell>
                      <div className="flex gap-1">
                        <Badge>{String(row.status)}</Badge>
                        {row.test ? <Badge tone="neutral">test</Badge> : null}
                      </div>
                    </TableCell>
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
