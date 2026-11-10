import type { RecordResolvedKeysResponse } from '@bottega/hub-data/client'
import {
  type CredentialPart,
  credentialParts,
  type TypedCredentialRow,
  typedCredentialRows,
} from '@/routes/-credential-rows'
import { credentialIdentityKey, credentialIdentityPath } from '../../../../shared/credential.ts'
import {
  type CredentialCandidate,
  credentialPayerFromScope,
  resolveCredential,
} from '../../../../shared/credential-resolution.ts'

type ResolvedKeySpace = RecordResolvedKeysResponse['spaces'][number]

/** Every space you belong to, or the named spaces, of which an empty list means none. */
export type Reach = 'all' | string[]

type AccountCredential = {
  key: string
  credential: string
  credentialParts: CredentialPart[]
  mode: TypedCredentialRow['mode']
  environment: TypedCredentialRow['environment']
  hint: string
  /** Spaces where at least one project resolves this account copy. */
  reach: Reach
  /** The spaces its reach admits, whether or not a project there resolves it. */
  configuredReach: Reach
  updatedAt: string
}

export type ResolvedKeyColumn = { id: string; credential: string; mode: TypedCredentialRow['mode'] }

type ResolvedCellKind = 'account' | 'own-project' | 'own-space' | 'shared-project' | 'shared-space'

export type ResolvedKeyCell =
  | {
      kind: ResolvedCellKind
      hint: string
      preferred: boolean
    }
  | { kind: 'none' }

type ResolvedKeyRow = { key: string; name: string; cells: Record<string, ResolvedKeyCell> }

export type ResolvedKeyGroup = {
  spaceId: string
  spaceName: string
  error: string | null
  rows: ResolvedKeyRow[]
}

export type ResolvedKeys = {
  personalSpaceId: string | null
  /** Why your personal space could not be read, which hides every account copy. */
  accountError: string | null
  account: AccountCredential[]
  columns: ResolvedKeyColumn[]
  groups: ResolvedKeyGroup[]
}

type Candidate = CredentialCandidate & { row: TypedCredentialRow }

/** The grid shows API keys; other credential types are infrastructure and stay on the Secrets page. */
const GRID_CREDENTIAL_TYPE = 'api-key'

const identityId = credentialIdentityKey

function isAccountRow(row: TypedCredentialRow) {
  return row.scope === 'user' && row.projectId === null
}

function reachNames(reach: readonly string[] | null, spaces: ResolvedKeySpace[]): Reach {
  if (reach === null) return 'all'
  return reach.map((id) => spaces.find((space) => space.id === id)?.name ?? 'a space you left')
}

function cellKind(candidate: Candidate): ResolvedCellKind {
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
  if (result.kind === 'refused') return { kind: 'none' }
  return {
    kind: cellKind(result.credential),
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

/** Names of the read spaces where some project's cell for this column resolved the account copy. */
function effectiveSpaces(groups: ResolvedKeyGroup[], columnId: string) {
  return groups
    .filter((group) => !group.error)
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
      if (space.error)
        return [{ spaceId: space.id, spaceName: space.name, error: space.error, rows: [] }]
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
          error: null,
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
  const readable = groups.filter((group) => !group.error).length
  return {
    personalSpaceId: data.personalSpaceId,
    accountError: personal?.error ?? null,
    account: accountRows.map((row) => {
      const configured = reachNames(row.reachSpaceIds ?? null, data.spaces)
      if (!columnsById.has(identityId(row)))
        return { ...accountSummary(row), reach: configured, configuredReach: configured }
      const served = effectiveSpaces(groups, identityId(row))
      if (served.length === readable)
        return { ...accountSummary(row), reach: configured, configuredReach: configured }
      return { ...accountSummary(row), reach: served, configuredReach: configured }
    }),
    columns: columnRows.map(([id, row]) => ({
      id,
      credential: credentialIdentityPath(row.provider, row.name, row.type),
      mode: row.mode,
    })),
    groups,
  }
}
