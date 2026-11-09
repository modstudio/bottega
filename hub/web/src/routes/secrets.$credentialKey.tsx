import { queryClient, trpc } from '@bottega/hub-data/client'
import { Button } from '@bottega/hub-ui/button'
import { Companion } from '@bottega/hub-ui/companion'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { DisplayRow, FieldSection } from '@bottega/hub-ui/form-layout'
import { relativeTime } from '@bottega/hub-util/format'
import { useMutation } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  credentialUsageReason,
  orderedUsages,
  preferenceDisplayLine,
  useCredentialRows,
} from '@/routes/-credential-rows'

export const Route = createFileRoute('/secrets/$credentialKey')({
  component: CredentialDetailRoute,
})

function CredentialDetailRoute() {
  const { credentialKey } = Route.useParams()
  const navigate = useNavigate()
  const credentials = useCredentialRows()
  const clearPreference = useMutation(
    trpc.record.clearCredentialPreference.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.record.credentialPreferences.queryKey() }),
    }),
  )
  const close = () => void navigate({ to: '/secrets', resetScroll: false })
  if (credentials.pending)
    return (
      <Companion title="Credential" subtitle="Loading credential..." onClose={close}>
        <EmptyState title="Loading credential..." />
      </Companion>
    )
  if (credentials.error)
    return (
      <Companion title="Credential" onClose={close}>
        <ErrorState
          title={`Could not load ${credentials.error.source}`}
          message={credentials.error.message}
        />
      </Companion>
    )
  const row = credentials.rows.find((candidate) => candidate.key === credentialKey)
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
            {orderedUsages(row.usages).map((usage) => (
              <li key={`${usage.projectId ?? 'space'}:${usage.name}`}>
                <strong>{usage.name}</strong>: {credentialUsageReason(usage.reason)}
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
              return (
                <li
                  key={`${preference.projectId ?? 'space'}:${preference.payer}:${preference.binding}`}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>{preferenceDisplayLine(preference, credentials.projects)}</span>
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
