import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useState } from 'react'
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
} from '@/lib/hosted-organization'
import { isHostedMode } from '@/lib/hub-mode'
import { Button } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { Select } from '@/ui/listbox/select'
import { PageHeader, SectionTitle } from '@/ui/page-header/page-header'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table/table'

export const Route = createFileRoute('/members')({ component: MembersRoute })
const roles: OrganizationRole[] = ['owner', 'admin', 'member']

function MembersRoute() {
  if (!isHostedMode()) return <Navigate to="/" />
  return <MembersPage />
}

function MembersPage() {
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
  if (members.isPending || invitations.isPending || caller.isPending) return <p>Loading members…</p>
  const loadError = members.error || invitations.error || caller.error
  if (loadError) return <p data-tone="error">{loadError.message}</p>
  const memberRows = members.data?.members ?? []
  const invitationRows = (invitations.data ?? []).filter(
    (invitation) =>
      invitation.status === 'pending' && new Date(invitation.expiresAt).getTime() > Date.now(),
  )
  const callerRole = caller.data?.role
  const canManage = callerRole === 'owner' || callerRole === 'admin'
  return (
    <section>
      <PageHeader title="Members" subtitle="Manage this space" />
      <SectionTitle detail={`${memberRows.length} total`}>Members</SectionTitle>
      <MemberTable rows={memberRows} callerRole={callerRole} onChanged={refresh} />
      <SectionTitle detail={`${invitationRows.length} pending`}>Pending invitations</SectionTitle>
      <InvitationTable
        rows={invitationRows}
        members={memberRows}
        canManage={canManage}
        onChanged={refresh}
      />
      {canManage ? <InviteForm callerRole={callerRole} onInvited={refresh} /> : null}
    </section>
  )
}

function MemberTable({
  rows,
  callerRole,
  onChanged,
}: {
  rows: OrganizationMember[]
  callerRole?: OrganizationRole
  onChanged: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: OrganizationRole }) =>
      updateOrganizationMemberRole(id, role),
    onSuccess: onChanged,
  })
  const remove = useMutation({ mutationFn: removeOrganizationMember, onSuccess: onChanged })
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
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((member) => {
          const allowed =
            callerRole === 'owner' || (callerRole === 'admin' && member.role !== 'owner')
          return (
            <TableRow key={member.id}>
              <TableCell>{member.user.name}</TableCell>
              <TableCell>{member.user.email}</TableCell>
              <TableCell>
                {allowed ? (
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
                )}
              </TableCell>
              <TableCell>
                {allowed ? (
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
                ) : null}
                {errors[member.id] ? (
                  <p data-tone="error" className="mt-1 text-sm text-status-text">
                    {errors[member.id]}
                  </p>
                ) : null}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
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
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>Invited by</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((invitation) => {
          const inviter = members.find((member) => member.userId === invitation.inviterId)?.user
          return (
            <TableRow key={invitation.id}>
              <TableCell>{invitation.email}</TableCell>
              <TableCell>{invitation.role}</TableCell>
              <TableCell>{new Date(invitation.expiresAt).toLocaleString()}</TableCell>
              <TableCell>
                {inviter ? `${inviter.name} (${inviter.email})` : invitation.inviterId}
              </TableCell>
              <TableCell>
                {canManage ? (
                  <div className="flex gap-2">
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
                      onClick={() =>
                        void act(invitation.id, () => cancel.mutateAsync(invitation.id))
                      }
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
                {errors[invitation.id] ? (
                  <p data-tone="error" className="mt-1 text-sm text-status-text">
                    {errors[invitation.id]}
                  </p>
                ) : null}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function InviteForm({
  callerRole,
  onInvited,
}: {
  callerRole?: OrganizationRole
  onInvited: () => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrganizationRole>('member')
  const invite = useMutation({
    mutationFn: () => inviteOrganizationMember(email, role),
    onSuccess: async () => {
      setEmail('')
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
      <label className="grid gap-1">
        <span>Email</span>
        <Input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
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
        onChange={(value) => setRole(value as OrganizationRole)}
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
