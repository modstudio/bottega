import { type RecordConfigAccessResponse, trpc } from '@bottega/hub-data/client'
import {
  activeOrganizationMember,
  cancelOrganizationInvitation,
  inviteOrganizationMember,
  listOrganizationInvitations,
  listOrganizationMembers,
  type OrganizationMember,
  type OrganizationRole,
  removeOrganizationMember,
  updateOrganizationMemberRole,
} from '@bottega/hub-data/hosted-organization'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Button } from '@bottega/hub-ui/button'
import { Collection, type CollectionColumn } from '@bottega/hub-ui/collection'
import { Dialog } from '@bottega/hub-ui/dialog'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { Input } from '@bottega/hub-ui/field/input'
import { Select } from '@bottega/hub-ui/listbox/select'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/members')({ component: MembersRoute })
const roles: OrganizationRole[] = ['owner', 'admin', 'member']
type MemberPermission = 'read' | 'write'
const permissionOptions = [
  { value: 'write', label: 'Write' },
  { value: 'read', label: 'Read' },
]

type MemberAccessRow = OrganizationMember & {
  permissionLabel: 'Write' | 'Read' | '-' | '…'
  /** The stored permission, or `null` while access is loading or the member has no row. */
  permission: MemberPermission | null
  configAccessLabel: 'Yes' | 'No' | '-' | '…'
  configAccess: boolean | null
}

export function joinMembersToConfigAccess(
  members: OrganizationMember[],
  accessRows: RecordConfigAccessResponse['items'],
): MemberAccessRow[] {
  const accessByEmail = new Map(accessRows.map((row) => [row.email.toLowerCase(), row]))
  return members.map((member) => {
    const access = accessByEmail.get(member.user.email.toLowerCase())
    return {
      ...member,
      permissionLabel: access ? (access.permission === 'write' ? 'Write' : 'Read') : '-',
      permission: access ? (access.permission === 'write' ? 'write' : 'read') : null,
      configAccessLabel: access ? (access.configAccess ? 'Yes' : 'No') : '-',
      configAccess: access?.configAccess ?? null,
    }
  })
}

function memberColumns(
  callerRole: OrganizationRole | undefined,
  canEditMember: (member: OrganizationMember) => boolean,
  changeRole: (member: OrganizationMember, role: OrganizationRole) => void,
  changePermission: (member: MemberAccessRow, permission: MemberPermission) => void,
): CollectionColumn<MemberAccessRow>[] {
  return [
    {
      id: 'name',
      label: 'Name',
      phone: 'title',
      render: (member) => member.user.name,
    },
    {
      id: 'email',
      label: 'Email',
      phone: 'line',
      render: (member) => member.user.email,
    },
    {
      id: 'role',
      label: 'Role',
      phone: 'aside',
      render: (member) =>
        !roles.includes(member.role) ? (
          member.role
        ) : canEditMember(member) ? (
          <Select
            label={`Role for ${member.user.name}`}
            size="sm"
            value={member.role}
            options={roles.map((role) => ({
              value: role,
              label: role,
              disabled: callerRole === 'admin' && role === 'owner',
            }))}
            onChange={(role) => changeRole(member, role as OrganizationRole)}
          />
        ) : (
          member.role
        ),
    },
    {
      id: 'permission',
      label: 'Permission',
      phone: 'line',
      // An owner always writes, so only a non-owner's permission is editable.
      render: (member) =>
        member.permission && member.role !== 'owner' && canEditMember(member) ? (
          <Select
            label={`Permission for ${member.user.name}`}
            size="sm"
            value={member.permission}
            options={permissionOptions}
            onChange={(permission) => changePermission(member, permission as MemberPermission)}
          />
        ) : (
          member.permissionLabel
        ),
    },
    {
      id: 'config-access',
      label: 'Config access',
      phone: 'line',
      render: (member) => member.configAccessLabel,
    },
  ]
}

function MemberRowActions({
  member,
  callerRole,
  callerEmail,
  canEdit,
  removeConfirm,
  error,
  onGrant,
  onWithdraw,
  onRemove,
}: {
  member: MemberAccessRow
  callerRole?: OrganizationRole
  callerEmail?: string
  canEdit: boolean
  removeConfirm: boolean
  error?: string
  onGrant: () => void
  onWithdraw: () => void
  onRemove: () => void
}) {
  const canWithdraw =
    callerRole === 'owner' &&
    member.role !== 'owner' &&
    member.configAccess === true &&
    member.user.email.toLowerCase() !== callerEmail?.toLowerCase()
  const canGrant = callerRole === 'owner' && member.configAccess === false
  if (!canEdit && !canWithdraw && !canGrant) return null
  return (
    <div className="grid gap-2">
      {canGrant ? (
        <Button size="sm" onClick={onGrant}>
          Grant config access
        </Button>
      ) : null}
      {canWithdraw ? (
        <Button size="sm" onClick={onWithdraw}>
          Withdraw config access
        </Button>
      ) : null}
      {canEdit ? (
        <Button size="sm" variant={removeConfirm ? 'danger' : 'secondary'} onClick={onRemove}>
          {removeConfirm ? 'Confirm remove' : 'Remove'}
        </Button>
      ) : null}
      {error ? (
        <p data-tone="error" className="text-sm text-status-text">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function MembersRoute() {
  if (!isHostedMode()) return <Navigate to="/" />
  return <MembersPage />
}

function MembersPage() {
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<OrganizationRole>('member')
  const members = useQuery({ queryKey: ['organization-members'], queryFn: listOrganizationMembers })
  const invitations = useQuery({
    queryKey: ['organization-invitations'],
    queryFn: listOrganizationInvitations,
  })
  const caller = useQuery({
    queryKey: ['organization-active-member'],
    queryFn: activeOrganizationMember,
  })
  const configAccess = useQuery(trpc.record.configAccess.queryOptions())
  const refresh = async () => {
    await Promise.all([
      members.refetch(),
      configAccess.refetch(),
      invitations.refetch(),
      caller.refetch(),
    ])
  }
  if (members.isPending || invitations.isPending || caller.isPending)
    return <EmptyState title="Loading members..." />
  const loadError = members.error || invitations.error || caller.error
  if (loadError) return <ErrorState title="Could not load members" message={loadError.message} />
  const memberRows = members.data?.members ?? []
  const accessRows = configAccess.isPending
    ? memberRows.map((member) => ({
        ...member,
        permissionLabel: '…' as const,
        permission: null,
        configAccessLabel: '…' as const,
        configAccess: null,
      }))
    : joinMembersToConfigAccess(memberRows, configAccess.data?.items ?? [])
  const invitationRows = (invitations.data ?? []).filter(
    (invitation) =>
      invitation.status === 'pending' && new Date(invitation.expiresAt).getTime() > Date.now(),
  )
  const callerRole = caller.data?.role
  const canManage = callerRole === 'owner' || callerRole === 'admin'
  const invite = canManage ? (
    <InviteForm
      callerRole={callerRole}
      email={inviteEmail}
      role={inviteRole}
      onEmailChange={setInviteEmail}
      onRoleChange={setInviteRole}
      onInvited={refresh}
    />
  ) : null
  return (
    <section>
      <PageHeader
        title="Members"
        about="Permission decides whether a member can change this space's work or only read it; owners always have write. Config access lets a member read and change this space's sealed configuration and secrets from their machines."
      />
      {configAccess.error ? (
        <div className="mb-4">
          <ErrorState title="Could not load access" message={configAccess.error.message} />
        </div>
      ) : null}
      <MemberTable
        rows={accessRows}
        callerRole={callerRole}
        callerEmail={caller.data?.user.email}
        onChanged={refresh}
        actions={invite}
      />
      <InvitationTable
        rows={invitationRows}
        members={memberRows}
        canManage={canManage}
        onChanged={refresh}
      />
    </section>
  )
}

function MemberTable({
  rows,
  callerRole,
  callerEmail,
  onChanged,
  actions,
}: {
  rows: MemberAccessRow[]
  callerRole?: OrganizationRole
  callerEmail?: string
  onChanged: () => Promise<void>
  actions?: React.ReactNode
}) {
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null)
  const [withdrawTarget, setWithdrawTarget] = useState<MemberAccessRow | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: OrganizationRole }) =>
      updateOrganizationMemberRole(id, role),
    onSuccess: onChanged,
  })
  const remove = useMutation({ mutationFn: removeOrganizationMember, onSuccess: onChanged })
  const grant = useMutation(trpc.record.grantConfigAccess.mutationOptions({ onSuccess: onChanged }))
  const withdraw = useMutation(
    trpc.record.withdrawConfigAccess.mutationOptions({ onSuccess: onChanged }),
  )
  const setPermission = useMutation(
    trpc.record.setMemberPermission.mutationOptions({ onSuccess: onChanged }),
  )
  const canEditMember = (member: OrganizationMember) =>
    callerRole === 'owner' || (callerRole === 'admin' && member.role !== 'owner')
  const act = async (id: string, operation: () => Promise<unknown>) => {
    setErrors((current) => ({ ...current, [id]: '' }))
    try {
      await operation()
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message : String(error),
      }))
    }
  }
  const columns = memberColumns(
    callerRole,
    canEditMember,
    (member, role) => {
      void act(member.id, () => changeRole.mutateAsync({ id: member.id, role }))
    },
    (member, permission) => {
      void act(member.id, () => setPermission.mutateAsync({ email: member.user.email, permission }))
    },
  )
  return (
    <>
      <Collection
        title="Members"
        count={rows.length}
        actions={actions}
        columns={columns}
        rows={rows}
        getKey={(member) => member.id}
        onOpen={() => undefined}
        rowActions={(member) => (
          <MemberRowActions
            member={member}
            callerRole={callerRole}
            callerEmail={callerEmail}
            canEdit={canEditMember(member)}
            removeConfirm={removeConfirm === member.id}
            error={errors[member.id]}
            onGrant={() =>
              void act(member.id, () => grant.mutateAsync({ email: member.user.email }))
            }
            onWithdraw={() => setWithdrawTarget(member)}
            onRemove={() =>
              removeConfirm === member.id
                ? void act(member.id, async () => {
                    await remove.mutateAsync(member.id)
                    setRemoveConfirm(null)
                  })
                : setRemoveConfirm(member.id)
            }
          />
        )}
        empty={{ title: 'No members.' }}
      />
      <Dialog
        open={withdrawTarget !== null}
        onOpenChange={(open) => {
          if (!open) setWithdrawTarget(null)
        }}
        title="Withdraw config access"
        description="Withdrawing config access revokes this member's machines and stops them reading this space's secrets."
        footer={
          <>
            <Button variant="secondary" onClick={() => setWithdrawTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={withdraw.isPending}
              onClick={() => {
                if (!withdrawTarget) return
                const member = withdrawTarget
                setWithdrawTarget(null)
                void act(member.id, () => withdraw.mutateAsync({ email: member.user.email }))
              }}
            >
              Withdraw
            </Button>
          </>
        }
      />
    </>
  )
}

function InvitationTable({
  rows,
  members,
  canManage,
  onChanged,
}: {
  rows: Awaited<ReturnType<typeof listOrganizationInvitations>>
  members: OrganizationMember[]
  canManage: boolean
  onChanged: () => Promise<void>
}) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const resend = useMutation({
    mutationFn: ({ email, role }: { email: string; role: OrganizationRole }) =>
      inviteOrganizationMember(email, role, true),
    onSuccess: onChanged,
  })
  const cancel = useMutation({ mutationFn: cancelOrganizationInvitation, onSuccess: onChanged })
  const act = async (id: string, operation: () => Promise<unknown>) => {
    try {
      setErrors((current) => ({ ...current, [id]: '' }))
      await operation()
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message : String(error),
      }))
    }
  }
  type Invitation = (typeof rows)[number]
  const columns: CollectionColumn<Invitation>[] = [
    { id: 'email', label: 'Email', phone: 'title', render: (invitation) => invitation.email },
    { id: 'role', label: 'Role', phone: 'aside', render: (invitation) => invitation.role },
    {
      id: 'expires',
      label: 'Expires',
      phone: 'line',
      render: (invitation) => new Date(invitation.expiresAt).toLocaleString(),
    },
    {
      id: 'inviter',
      label: 'Invited by',
      phone: 'line',
      render: (invitation) => {
        const inviter = members.find((member) => member.userId === invitation.inviterId)?.user
        return inviter ? `${inviter.name} (${inviter.email})` : invitation.inviterId
      },
    },
  ]
  return (
    <Collection
      title="Pending invitations"
      count={rows.length}
      columns={columns}
      rows={rows}
      getKey={(invitation) => invitation.id}
      onOpen={() => undefined}
      rowActions={(invitation) =>
        canManage ? (
          <div className="grid gap-2">
            <Button
              size="sm"
              onClick={() =>
                void act(invitation.id, () =>
                  resend.mutateAsync({ email: invitation.email, role: invitation.role }),
                )
              }
            >
              Resend
            </Button>
            <Button
              size="sm"
              onClick={() => void act(invitation.id, () => cancel.mutateAsync(invitation.id))}
            >
              Cancel
            </Button>
            {errors[invitation.id] ? (
              <p data-tone="error" className="text-sm text-status-text">
                {errors[invitation.id]}
              </p>
            ) : null}
          </div>
        ) : null
      }
      empty={{ title: 'No pending invitations.' }}
    />
  )
}

function InviteForm({
  callerRole,
  email,
  role,
  onEmailChange,
  onRoleChange,
  onInvited,
}: {
  callerRole?: OrganizationRole
  email: string
  role: OrganizationRole
  onEmailChange: (email: string) => void
  onRoleChange: (role: OrganizationRole) => void
  onInvited: () => Promise<void>
}) {
  const invite = useMutation({
    mutationFn: () => inviteOrganizationMember(email, role),
    onSuccess: async () => {
      onEmailChange('')
      await onInvited()
    },
  })
  return (
    <form
      className="mt-8 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        invite.mutate()
      }}
    >
      <label htmlFor="member-invite-email" className="grid gap-1">
        <span>Email</span>
        <Input
          id="member-invite-email"
          type="email"
          required
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
        />
      </label>
      <Select
        label="Invitation role"
        value={role}
        options={roles.map((value) => ({
          value,
          label: value,
          disabled: callerRole === 'admin' && value === 'owner',
        }))}
        onChange={(value) => onRoleChange(value as OrganizationRole)}
      />
      <Button variant="primary" type="submit" disabled={invite.isPending}>
        Invite
      </Button>
      {invite.error ? (
        <p data-tone="error" className="w-full text-status-text">
          {invite.error.message}
        </p>
      ) : null}
    </form>
  )
}
