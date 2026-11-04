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
  const refresh = async () => {
    await Promise.all([members.refetch(), invitations.refetch(), caller.refetch()])
  }
  if (members.isPending || invitations.isPending || caller.isPending)
    return <EmptyState title="Loading members..." />
  const loadError = members.error || invitations.error || caller.error
  if (loadError) return <ErrorState title="Could not load members" message={loadError.message} />
  const memberRows = members.data?.members ?? []
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
      <PageHeader title="Members" subtitle="Manage this space" />
      <MemberTable rows={memberRows} callerRole={callerRole} onChanged={refresh} actions={invite} />
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
  onChanged,
  actions,
}: {
  rows: OrganizationMember[]
  callerRole?: OrganizationRole
  onChanged: () => Promise<void>
  actions?: React.ReactNode
}) {
  const [confirm, setConfirm] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: OrganizationRole }) =>
      updateOrganizationMemberRole(id, role),
    onSuccess: onChanged,
  })
  const remove = useMutation({ mutationFn: removeOrganizationMember, onSuccess: onChanged })
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
  const columns: CollectionColumn<OrganizationMember>[] = [
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
      render: (member) => {
        return canEditMember(member) ? (
          <Select
            label={`Role for ${member.user.name}`}
            size="sm"
            value={member.role}
            options={roles.map((role) => ({
              value: role,
              label: role,
              disabled: callerRole === 'admin' && role === 'owner',
            }))}
            onChange={(role) =>
              void act(member.id, () =>
                changeRole.mutateAsync({ id: member.id, role: role as OrganizationRole }),
              )
            }
          />
        ) : (
          member.role
        )
      },
    },
  ]
  return (
    <Collection
      title="Members"
      count={rows.length}
      actions={actions}
      columns={columns}
      rows={rows}
      getKey={(member) => member.id}
      onOpen={() => undefined}
      rowActions={(member) => {
        return canEditMember(member) ? (
          <div className="grid gap-2">
            <Button
              size="sm"
              variant={confirm === member.id ? 'danger' : 'secondary'}
              onClick={() =>
                confirm === member.id
                  ? void act(member.id, async () => {
                      await remove.mutateAsync(member.id)
                      setConfirm(null)
                    })
                  : setConfirm(member.id)
              }
            >
              {confirm === member.id ? 'Confirm remove' : 'Remove'}
            </Button>
            {errors[member.id] ? (
              <p data-tone="error" className="text-sm text-status-text">
                {errors[member.id]}
              </p>
            ) : null}
          </div>
        ) : null
      }}
      empty={{ title: 'No members.' }}
    />
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
