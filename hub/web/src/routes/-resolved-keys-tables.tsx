import { trpc } from '@bottega/hub-data/client'
import { Badge } from '@bottega/hub-ui/badge'
import { Collection, type CollectionColumn } from '@bottega/hub-ui/collection'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { Tooltip } from '@bottega/hub-ui/tooltip'
import { useQuery } from '@tanstack/react-query'
import { Building2, Pin, User } from 'lucide-react'
import { useMemo, useState } from 'react'
import { type ResolvedKeyCell, type ResolvedKeyColumn, resolvedKeys } from '@/routes/-resolved-keys'

type GridRow = {
  key: string
  spaceName: string
  name: string
  cells: Record<string, ResolvedKeyCell>
}

const CELL_OWNER = {
  account: 'yours',
  'own-project': 'yours',
  'own-space': 'yours',
  'shared-project': 'space',
  'shared-space': 'space',
} as const

const CELL_SCOPE = {
  account: 'All spaces',
  'own-project': 'Project',
  'own-space': 'Space',
  'shared-project': 'Project',
  'shared-space': 'Space',
} as const

const CELL_MEANING = {
  account: 'Your personal key, used in every space its reach admits',
  'own-project': 'Your key, set for this project',
  'own-space': 'Your key, for every project in this space',
  'shared-project': "The space's key, set for this project",
  'shared-space': "The space's key, for every project in it",
} as const

/** The owner as an icon and the scope as a tag, solid where a copy overrides your personal key. */
function Cell({ cell }: { cell: ResolvedKeyCell | undefined }) {
  if (!cell || cell.kind === 'none')
    return <span className="text-text-muted">{cell ? 'Not set' : '—'}</span>
  const yours = CELL_OWNER[cell.kind] === 'yours'
  return (
    <span className="inline-flex flex-col items-start gap-1 leading-tight">
      <span className="inline-flex items-center gap-1.5">
        <Tooltip label={CELL_MEANING[cell.kind]}>
          <Badge
            icon={yours ? User : Building2}
            emphasis={cell.kind === 'account' ? 'subtle' : 'solid'}
          >
            {CELL_SCOPE[cell.kind]}
          </Badge>
        </Tooltip>
        {cell.preferred ? (
          <Badge tone="info" icon={Pin}>
            Preferred
          </Badge>
        ) : null}
      </span>
      <span className="text-text-muted text-xs">{cell.hint}</span>
    </span>
  )
}

function gridColumns(
  columns: ResolvedKeyColumn[],
  showSpace: boolean,
): CollectionColumn<GridRow>[] {
  const space: CollectionColumn<GridRow> = {
    id: 'space',
    label: 'Space',
    phone: 'aside',
    render: (row) => row.spaceName,
  }
  return [
    ...(showSpace ? [space] : []),
    { id: 'project', label: 'Project', phone: 'title', render: (row) => row.name },
    ...columns.map(
      (column): CollectionColumn<GridRow> => ({
        id: column.id,
        label:
          column.mode === 'default' ? column.credential : `${column.credential} (${column.mode})`,
        phone: 'more',
        render: (row) => <Cell cell={row.cells[column.id]} />,
      }),
    ),
  ]
}

/** Every space's resolved keys, read once and shared by the Secrets page's tabs. */
export function useResolvedKeys() {
  const keys = useQuery(trpc.record.resolvedKeys.queryOptions())
  const view = useMemo(() => (keys.data ? resolvedKeys(keys.data) : null), [keys.data])
  return { view, pending: keys.isPending, error: keys.error?.message ?? null }
}

export type ResolvedKeysView = NonNullable<ReturnType<typeof useResolvedKeys>['view']>

/** The groups a space shows: your personal space shows every space, any other space only itself. */
function visibleGroups(view: ResolvedKeysView, spaceId: string) {
  if (spaceId === view.personalSpaceId) return view.groups
  return view.groups.filter((group) => group.spaceId === spaceId)
}

export function projectRowCount(view: ResolvedKeysView | null, spaceId: string) {
  if (!view) return undefined
  return visibleGroups(view, spaceId).reduce((total, group) => total + group.rows.length, 0)
}

function Loading({ pending, error }: { pending: boolean; error: string | null }) {
  if (error) return <ErrorState title="Could not load resolved keys" message={error} />
  return pending ? <EmptyState title="Loading resolved keys..." /> : null
}

/** Which copy of each API key every project in your spaces resolves. */
export function ResolvedByProject({
  keys,
  spaceId,
}: {
  keys: ReturnType<typeof useResolvedKeys>
  spaceId: string
}) {
  const [search, setSearch] = useState('')
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (keys.view ? visibleGroups(keys.view, spaceId) : [])
      .flatMap((group) => group.rows.map((row) => ({ ...row, spaceName: group.spaceName })))
      .filter((row) => !needle || `${row.spaceName} ${row.name}`.toLowerCase().includes(needle))
  }, [keys.view, spaceId, search])
  if (!keys.view) return <Loading pending={keys.pending} error={keys.error} />
  return (
    <div className="flex flex-col gap-4">
      {visibleGroups(keys.view, spaceId)
        .filter((group) => group.error)
        .map((group) => (
          <ErrorState
            key={group.spaceId}
            title={`Could not read ${group.spaceName}`}
            message={group.error ?? ''}
          />
        ))}
      <Collection
        title="API keys by project"
        count={rows.length}
        search={{
          query: search,
          onQueryChange: setSearch,
          placeholder:
            spaceId === keys.view.personalSpaceId
              ? 'Search spaces and projects'
              : 'Search projects',
        }}
        columns={gridColumns(keys.view.columns, spaceId === keys.view.personalSpaceId)}
        rows={rows}
        getKey={(row) => row.key}
        onOpen={() => {}}
        empty={{
          title: search.trim() ? 'No projects match this search.' : 'No projects in your spaces.',
        }}
      />
    </div>
  )
}
