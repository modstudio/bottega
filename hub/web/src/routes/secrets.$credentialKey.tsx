import { queryClient, trpc } from '@bottega/hub-data/client'
import { Button } from '@bottega/hub-ui/button'
import { Companion } from '@bottega/hub-ui/companion'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { DisplayRow, FieldSection } from '@bottega/hub-ui/form-layout'
import { relativeTime } from '@bottega/hub-util/format'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { credentialDisplayRows, splitSecretRows } from '@/routes/secrets'

const PAYER_LABEL = { personal: 'You', shared: 'Shared' } as const

export const Route = createFileRoute('/secrets/$credentialKey')({
  component: CredentialDetailRoute,
})

function usageReason(reason: 'project-preference' | 'space-preference' | 'default-order') {
  if (reason === 'project-preference') return 'preference for this project'
  if (reason === 'space-preference') return 'space-wide preference'
  return 'default order'
}

function CredentialDetailRoute() {
  const { credentialKey } = Route.useParams()
  const navigate = useNavigate()
  const secrets = useQuery(trpc.record.configSecrets.queryOptions())
  const preferences = useQuery(trpc.record.credentialPreferences.queryOptions())
  const projects = useQuery(trpc.record.projects.queryOptions())
  const whoami = useQuery(trpc.record.whoami.queryOptions())
  const clearPreference = useMutation(
    trpc.record.clearCredentialPreference.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.record.credentialPreferences.queryKey() }),
    }),
  )
  const close = () => void navigate({ to: '/secrets', resetScroll: false })
  const pending =
    secrets.isPending || preferences.isPending || projects.isPending || whoami.isPending
  const error = secrets.error ?? preferences.error ?? projects.error ?? whoami.error
  if (pending)
    return (
      <Companion title="Credential" subtitle="Loading credential..." onClose={close}>
        <EmptyState title="Loading credential..." />
      </Companion>
    )
  if (error)
    return (
      <Companion title="Credential" onClose={close}>
        <ErrorState title="Could not load the credential" message={error.message} />
      </Companion>
    )
  const spaceId = whoami.data?.activeSpaceId ?? projects.data?.[0]?.spaceId ?? ''
  const rows = credentialDisplayRows(
    splitSecretRows(secrets.data ?? []).credentials,
    preferences.data ?? [],
    projects.data ?? [],
    spaceId,
  )
  const row = rows.find((candidate) => candidate.key === credentialKey)
  if (!row)
    return (
      <Companion title="Credential" onClose={close}>
        <ErrorState
          title="Credential not found"
          message="Close the panel and choose another row."
        />
      </Companion>
    )
  return (
    <Companion title={row.credential} subtitle={`${row.mode} · ${row.environment}`} onClose={close}>
      <DisplayRow label="Credential" value={row.credential} />
      <DisplayRow label="Mode" value={row.mode} />
      <DisplayRow label="Environment" value={row.environment} />
      <DisplayRow label="Bound to" value={row.boundTo} />
      <DisplayRow label="Owner" value={row.owner} />
      <DisplayRow
        label="Hint"
        value={
          row.missing ? (
            <span data-tone="warning" className="text-status-text">
              missing
            </span>
          ) : (
            row.hint
          )
        }
      />
      <DisplayRow label="Last changed" value={relativeTime(row.updatedAt)} />
      <FieldSection title="Used by">
        {row.usages.length ? (
          <ul className="grid gap-2">
            {row.usages.map((usage) => (
              <li key={`${usage.projectId ?? 'space'}:${usage.name}`}>
                <strong>{usage.name}</strong>: {usageReason(usage.reason)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-text-muted">No project resolves to this copy.</p>
        )}
      </FieldSection>
      <FieldSection title="Preferences">
        {row.preferences.length ? (
          <ul className="grid gap-3">
            {row.preferences.map((preference) => {
              const project =
                preference.projectId === null
                  ? 'All projects'
                  : (projects.data?.find((item) => item.id === preference.projectId)?.name ??
                    'Unknown project')
              return (
                <li
                  key={`${preference.projectId ?? 'space'}:${preference.payer}:${preference.binding}`}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>
                    {project}: pays with {PAYER_LABEL[preference.payer]}, {preference.binding}{' '}
                    credential
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={clearPreference.isPending}
                    onClick={() => clearPreference.mutate(preference)}
                  >
                    Clear
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-text-muted">No preference selects this copy.</p>
        )}
        {clearPreference.error ? (
          <p data-tone="error" className="mt-2 text-status-text">
            {clearPreference.error.message}
          </p>
        ) : null}
      </FieldSection>
    </Companion>
  )
}
