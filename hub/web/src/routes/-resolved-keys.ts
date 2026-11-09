import type { RecordResolvedKeysResponse } from '@bottega/hub-data/client'
import {
  type CredentialPart,
  credentialParts,
  type TypedCredentialRow,
  typedCredentialRows,
} from '@/routes/-credential-rows'
import { credentialIdentityPath } from '../../../../shared/credential.ts'
import {
  type CredentialCandidate,
  credentialPayerFromScope,
  resolveCredential,
} from '../../../../shared/credential-resolution.ts'

type ResolvedKeySpace = RecordResolvedKeysResponse['spaces'][number]

type AccountCredential = {
  key: string
  credential: string
  credentialParts: CredentialPart[]
  mode: TypedCredentialRow['mode']
  environment: TypedCredentialRow['environment']
  hint: string
  /** Spaces where at least one project resolves this account copy. */
  reach: string
  /** The spaces its reach admits, whether or not a project there resolves it. */
  configuredReach: string
  updatedAt: string
}

export type ResolvedKeyColumn = { id: string; credential: string; mode: TypedCredentialRow['mode'] }

export type ResolvedKeyCell =
  | {
      kind: 'account' | 'own-project' | 'own-space' | 'shared-project' | 'shared-space'
      label: string
      hint: string
      preferred: boolean
    }
  | { kind: 'none'; label: string }

type ResolvedKeyRow = { key: string; name: string; cells: Record<string, ResolvedKeyCell> }

export type ResolvedKeyGroup = {
  spaceId: string
  spaceName: string
  error: string | null
  rows: ResolvedKeyRow[]
}

export type ResolvedKeys = {
  personalSpaceId: string | null
  account: AccountCredential[]
  columns: ResolvedKeyColumn[]
  groups: ResolvedKeyGroup[]
}

type Candidate = CredentialCandidate & { row: TypedCredentialRow }

/** The grid shows API keys; other credential types are infrastructure and stay on the Secrets page. */
const GRID_CREDENTIAL_TYPE = 'api-key'

function identityId(
  row: Pick<TypedCredentialRow, 'provider' | 'name' | 'type' | 'mode' | 'environment'>,
) {
  return `${credentialIdentityPath(row.provider, row.name, row.type)}#${row.mode}@${row.environment}`
}

function isAccountRow(row: TypedCredentialRow) {
  return row.scope === 'user' && row.projectId === null
}

function reachLabel(reach: readonly string[] | null, spaces: ResolvedKeySpace[]) {
  if (reach === null) return 'All your spaces'
  if (!reach.length) return 'No spaces'
  return reach
    .map((id) => spaces.find((space) => space.id === id)?.name ?? 'a space you left')
    .join(', ')
}

const CELL_LABEL = {
  account: 'Yours · all spaces',
  'own-project': 'Yours · project',
  'own-space': 'Yours · space',
  'shared-project': 'Space · project',
  'shared-space': 'Space · space',
} as const

function cellKind(candidate: Candidate): keyof typeof CELL_LABEL {
  if (candidate.account) return 'account'
  const owner = candidate.payer === 'personal' ? 'own' : 'shared'
  return candidate.projectId === null ? `${owner}-space` : `${owner}-project`
}

function resolvedCell(
  input: Omit<
    Parameters<typeof resolveCredential<Candidate>>[0],
    'provider' | 'name' | 'type' | 'mode' | 'environment'
  >,
  column: TypedCredentialRow,
): ResolvedKeyCell {
  const result = resolveCredential<Candidate>({
    ...input,
    provider: column.provider,
    name: column.name,
    type: column.type,
    mode: column.mode,
    environment: column.environment,
  })
  if (result.kind === 'refused') return { kind: 'none', label: 'Not set' }
  const kind = cellKind(result.credential)
  return {
    kind,
    label: CELL_LABEL[kind],
    hint: result.credential.row.hint,
    preferred: result.reason === 'project-preference' || result.reason === 'space-preference',
  }
}

function accountSummary(row: TypedCredentialRow) {
  return {
    key: identityId(row),
    credential: credentialIdentityPath(row.provider, row.name, row.type),
    credentialParts: credentialParts(row),
    mode: row.mode,
    environment: row.environment,
    hint: row.hint,
    updatedAt: row.updatedAt,
  }
}

/** Names of the spaces where some project's cell for this column resolved the account copy. */
function effectiveSpaces(groups: ResolvedKeyGroup[], columnId: string) {
  return groups
    .filter((group) => group.rows.some((row) => row.cells[columnId]?.kind === 'account'))
    .map((group) => group.spaceName)
}

/** Which copy of each API key every project resolves, by the run resolver's own rules. */
export function resolvedKeys(data: RecordResolvedKeysResponse): ResolvedKeys {
  const personal = data.spaces.find((space) => space.id === data.personalSpaceId)
  const accountRows = typedCredentialRows(personal?.secrets ?? []).filter(isAccountRow)
  const accountCandidates: Candidate[] = accountRows.map((row) => ({
    ...row,
    row,
    spaceId: data.personalSpaceId ?? '',
    payer: credentialPayerFromScope(row.scope),
    account: { ownerUserId: data.userId, reachSpaceIds: row.reachSpaceIds ?? null },
  }))
  const columnsById = new Map<string, TypedCredentialRow>()
  for (const space of data.spaces)
    for (const row of typedCredentialRows(space.secrets))
      if (row.type === GRID_CREDENTIAL_TYPE) columnsById.set(identityId(row), row)
  const columnRows = [...columnsById.entries()].sort(([left], [right]) => left.localeCompare(right))
  const groups = [...data.spaces]
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((space): ResolvedKeyGroup[] => {
      const projects = space.projects.filter((project) => project.retiredAt === null)
      if (space.id === data.personalSpaceId && !projects.length) return []
      const ownRows = typedCredentialRows(space.secrets).filter(
        (row) => space.id !== data.personalSpaceId || !isAccountRow(row),
      )
      const candidates: Candidate[] = [
        ...ownRows.map((row) => ({
          ...row,
          row,
          spaceId: space.id,
          payer: credentialPayerFromScope(row.scope),
        })),
        ...accountCandidates,
      ]
      const targets = projects.length
        ? projects
            .map((project) => ({ id: project.id as string | null, name: project.name }))
            .sort((left, right) => left.name.localeCompare(right.name))
        : [{ id: null, name: 'Space default' }]
      return [
        {
          spaceId: space.id,
          spaceName: space.name,
          error: space.error,
          rows: targets.map((target) => ({
            key: `${space.id}:${target.id ?? 'space'}`,
            name: target.name,
            cells: Object.fromEntries(
              columnRows.map(([id, column]) => [
                id,
                resolvedCell(
                  {
                    userId: data.userId,
                    personalSpaceId: data.personalSpaceId,
                    spaceId: space.id,
                    projectId: target.id,
                    projectName: target.id ? target.name : undefined,
                    spaceName: space.name,
                    candidates,
                    preferences: space.preferences,
                  },
                  column,
                ),
              ]),
            ),
          })),
        },
      ]
    })
  return {
    personalSpaceId: data.personalSpaceId,
    account: accountRows.map((row) => {
      const configured = reachLabel(row.reachSpaceIds ?? null, data.spaces)
      if (!columnsById.has(identityId(row)))
        return { ...accountSummary(row), reach: configured, configuredReach: configured }
      const served = effectiveSpaces(groups, identityId(row))
      if (served.length === groups.length)
        return { ...accountSummary(row), reach: configured, configuredReach: configured }
      const reach = served.length ? served.join(', ') : 'No project uses it'
      return { ...accountSummary(row), reach, configuredReach: configured }
    }),
    columns: columnRows.map(([id, row]) => ({
      id,
      credential: credentialIdentityPath(row.provider, row.name, row.type),
      mode: row.mode,
    })),
    groups,
  }
}
