import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Badge } from '@bottega/hub-ui/badge'
import { Callout } from '@bottega/hub-ui/callout'
import { Collection, type CollectionColumn } from '@bottega/hub-ui/collection'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { Tabs } from '@bottega/hub-ui/tabs'
import { relativeTime } from '@bottega/hub-util/format'
import { createFileRoute, Navigate, useNavigate, useParams } from '@tanstack/react-router'
import { Fragment, useId, useMemo, useState } from 'react'
import {
  type CredentialDisplayRow,
  type CredentialPart,
  credentialRowMatches,
  orderedUsages,
  usageLabel,
  useCredentialRows,
} from '@/routes/-credential-rows'
import { useDetailPanel } from '@/routes/-detail-panel'
import type { Reach, ResolvedKeyGroup, ResolvedKeys } from '@/routes/-resolved-keys'
import { projectRowCount, ResolvedByProject, useResolvedKeys } from '@/routes/-resolved-keys-tables'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'

export const Route = createFileRoute('/secrets')({ component: SecretsRoute })

const CREDENTIAL_COMMAND = `${PLATFORM_SLUG} credential`

/** A row of the Credentials list: a copy in this space, or one of your account copies. */
type SecretsRow = CredentialDisplayRow & { account?: { usedBy: string; configuredReach: Reach } }

const ACCOUNT_ROW_PREFIX = 'account:'

function reachText(reach: Reach, none: string) {
  if (reach === 'all') return 'All your spaces'
  return reach.length ? reach.join(', ') : none
}

/** This space's projects that resolve the account copy, so a team space never lists another space. */
function projectsResolving(group: ResolvedKeyGroup | undefined, columnId: string) {
  const names = (group?.rows ?? [])
    .filter((row) => row.cells[columnId]?.kind === 'account')
    .map((row) => row.name)
  return names.length ? names.join(', ') : '—'
}

/** Your account copies, which resolve across spaces, beside this space's own credentials. */
function withAccountRows(
  rows: CredentialDisplayRow[],
  spaceId: string,
  view: ResolvedKeys | null,
): SecretsRow[] {
  if (!view) return rows
  const personal = spaceId === view.personalSpaceId
  const group = view.groups.find((candidate) => candidate.spaceId === spaceId)
  const gridded = new Set(view.columns.map((column) => column.id))
  const own = rows.filter((row) => !personal || !row.accountCopy)
  const account: SecretsRow[] = view.account.map((row) => ({
    key: `${ACCOUNT_ROW_PREFIX}${row.key}`,
    credential: row.credential,
    credentialParts: row.credentialParts,
    mode: row.mode,
    environment: row.environment,
    boundTo: 'Your account',
    owner: 'You',
    hint: row.hint,
    updatedAt: row.updatedAt,
    missing: false,
    accountCopy: true,
    usages: [],
    preferences: [],
    account: {
      usedBy:
        personal || !gridded.has(row.key)
          ? reachText(row.reach, 'No project uses it')
          : projectsResolving(group, row.key),
      configuredReach: row.configuredReach,
    },
  }))
  return [...own, ...account]
}

function secretsRowMatches(row: SecretsRow, query: string) {
  if (credentialRowMatches(row, query)) return true
  return !!row.account?.usedBy.toLowerCase().includes(query.trim().toLowerCase())
}

/** Your account copy names its reach beneath, since it resolves in every space that reach admits. */
function BoundTo({ row }: { row: SecretsRow }) {
  if (!row.account) return row.boundTo
  return (
    <span className="inline-flex flex-col leading-tight">
      <span>{row.boundTo}</span>
      <span className="text-text-muted text-xs">
        Reaches{' '}
        {row.account.configuredReach === 'all'
          ? 'all your spaces'
          : reachText(row.account.configuredReach, 'no spaces')}
      </span>
    </span>
  )
}

function UsedBy({ row }: { row: SecretsRow }) {
  if (row.account)
    return (
      <span className="inline-flex flex-col leading-tight">
        <span>{row.account.usedBy}</span>
      </span>
    )
  if (!row.usages.length) return '—'
  const ordered = orderedUsages(row.usages)
  const [first, ...rest] = ordered
  if (first?.projectId !== null) return ordered.map(usageLabel).join(', ')
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge>{usageLabel(first)}</Badge>
      {rest.length ? <span>{rest.map(usageLabel).join(', ')}</span> : null}
    </span>
  )
}

function CredentialName({ parts }: { parts: CredentialPart[] }) {
  return parts.map((part) => (
    <Fragment key={part.role}>
      {part.role !== 'provider' ? (
        <span aria-hidden className="px-1 text-text-muted">
          ·
        </span>
      ) : null}
      {part.value}
    </Fragment>
  ))
}

const credentialColumns: CollectionColumn<SecretsRow>[] = [
  {
    id: 'credential',
    label: 'Credential',
    phone: 'title',
    render: (row) => <CredentialName parts={row.credentialParts} />,
  },
  { id: 'mode', label: 'Mode', phone: 'aside', render: (row) => row.mode },
  { id: 'binding', label: 'Bound to', phone: 'line', render: (row) => <BoundTo row={row} /> },
  { id: 'owner', label: 'Owner', phone: 'line', render: (row) => row.owner },
  {
    id: 'used-by',
    label: 'Used by',
    phone: 'line',
    grow: true,
    render: (row) => <UsedBy row={row} />,
  },
  {
    id: 'hint',
    label: 'Hint',
    phone: 'more',
    render: (row) =>
      row.missing ? (
        <span data-tone="warning" className="text-status-text">
          missing
        </span>
      ) : (
        row.hint
      ),
  },
  {
    id: 'changed',
    label: 'Last changed',
    phone: 'more',
    render: (row) => relativeTime(row.updatedAt),
  },
]

type SecretsTab = 'credentials' | 'resolved'

function SecretsRoute() {
  if (!isHostedMode()) return <Navigate to="/" />
  return <SecretsPage />
}

function SecretsPage() {
  const credentials = useCredentialRows()
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<SecretsTab>('credentials')
  const tabsId = useId()
  const keys = useResolvedKeys()
  const rows = useMemo(
    () =>
      withAccountRows(credentials.rows, credentials.spaceId, keys.view).filter((row) =>
        secretsRowMatches(row, search),
      ),
    [credentials.rows, credentials.spaceId, keys.view, search],
  )
  return (
    <section>
      <PageHeader
        title="Secrets"
        about={`Set and delete values with ${CREDENTIAL_COMMAND} set and ${CREDENTIAL_COMMAND} delete, and choose which copy a project uses with ${CREDENTIAL_COMMAND} prefer. Each project resolves the first copy of a key that applies to it: your copy for the project or space, then your personal key, which follows you into every space its reach admits, then a shared copy. Values never reach this page.`}
      />
      <Tabs
        id={tabsId}
        label="Secrets"
        value={tab}
        onChange={(value) => setTab(value as SecretsTab)}
        items={[
          {
            value: 'credentials',
            label: 'Credentials',
            count: credentials.pending ? undefined : rows.length,
          },
          {
            value: 'resolved',
            label: 'Resolved keys',
            count: projectRowCount(keys.view, credentials.spaceId),
          },
        ]}
      />
      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-tab-${tab}`}
        className="mt-4"
      >
        {tab === 'resolved' ? (
          <ResolvedByProject keys={keys} spaceId={credentials.spaceId} />
        ) : (
          <CredentialsTab
            accountError={keys.view?.accountError ?? null}
            credentials={credentials}
            rows={rows}
            search={search}
            onSearch={setSearch}
          />
        )}
      </div>
    </section>
  )
}

function CredentialsTab({
  accountError,
  credentials,
  rows,
  search,
  onSearch,
}: {
  accountError: string | null
  credentials: ReturnType<typeof useCredentialRows>
  rows: SecretsRow[]
  search: string
  onSearch: (query: string) => void
}) {
  const navigate = useNavigate()
  const panel = useDetailPanel()
  const selectedKey = useParams({ strict: false }).credentialKey
  if (credentials.pending) return <EmptyState title="Loading credentials..." />
  if (credentials.error)
    return (
      <ErrorState
        title={`Could not load ${credentials.error.source}`}
        message={credentials.error.message}
      />
    )
  return (
    <>
      {accountError ? (
        <ErrorState title="Could not read your personal keys" message={accountError} />
      ) : null}
      <Collection
        title="Credentials"
        count={rows.length}
        search={{ query: search, onQueryChange: onSearch, placeholder: 'Search credentials' }}
        panel={panel}
        selectedKey={selectedKey}
        columns={credentialColumns}
        rows={rows}
        getKey={(row) => row.key}
        onOpen={(row) =>
          row.account
            ? undefined
            : void navigate({
                to: '/secrets/$credentialKey',
                params: { credentialKey: row.key },
                resetScroll: false,
              })
        }
        empty={{
          title: search.trim()
            ? 'No credentials match this search.'
            : 'No credentials in this space.',
          hint: search.trim()
            ? 'Clear the search to see every credential.'
            : `Set one with ${CREDENTIAL_COMMAND} set.`,
        }}
      />
      {credentials.untypedCount > 0 ? (
        <Callout
          tone="neutral"
          title={`${credentials.untypedCount} sealed configuration ${credentials.untypedCount === 1 ? 'key is not a typed credential. List it' : 'keys are not typed credentials. List them'} with ${PLATFORM_SLUG} machine config secret list.`}
        />
      ) : null}
    </>
  )
}
