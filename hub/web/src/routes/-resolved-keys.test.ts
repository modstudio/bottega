import { expect, test } from 'bun:test'
import type { HostedProjectRow, RecordResolvedKeysResponse } from '@bottega/hub-data/client'
import { resolvedKeys } from './-resolved-keys.ts'

const userId = '01990000-0000-7000-8000-000000000001'
const personalId = '01990000-0000-7000-8000-000000000010'
const teamId = '01990000-0000-7000-8000-000000000020'
const otherId = '01990000-0000-7000-8000-000000000030'
const updatedAt = '2026-11-05T12:00:00.000Z'
const column = 'openrouter/api-key#default@local'

type Space = RecordResolvedKeysResponse['spaces'][number]
type Secret = Space['secrets'][number]

function project(spaceId: string, suffix: string, name: string): HostedProjectRow {
  return {
    id: `${spaceId.slice(0, -2)}${suffix}`,
    spaceId,
    spaceName: name,
    name,
    keyPrefixes: [name],
    stack: null,
    managedContext: true,
    landingBranch: 'main',
    color: null,
    colorDark: null,
    retiredAt: null,
  }
}

function openrouter(
  fields: Pick<Secret, 'scope' | 'projectId' | 'hint' | 'reachSpaceIds'>,
): Secret {
  return {
    key: column,
    environment: 'local',
    provider: 'openrouter',
    name: null,
    type: 'api-key',
    mode: 'default',
    updatedAt,
    ...fields,
  }
}

function space(id: string, name: string, secrets: Secret[], projects: HostedProjectRow[]): Space {
  return { id, name, secrets, preferences: [], projects, error: null }
}

const teamOwn = project(teamId, '21', 'own')
const teamShared = project(teamId, '22', 'shared')
const other = project(otherId, '31', 'other')

function data(reachSpaceIds: string[] | null): RecordResolvedKeysResponse {
  return {
    userId,
    personalSpaceId: personalId,
    spaces: [
      space(
        personalId,
        'Personal',
        [openrouter({ scope: 'user', projectId: null, hint: 'acct', reachSpaceIds })],
        [],
      ),
      space(
        teamId,
        'Team',
        [openrouter({ scope: 'user', projectId: teamOwn.id, hint: 'proj', reachSpaceIds: null })],
        [teamOwn, teamShared],
      ),
      space(otherId, 'Other', [], [other]),
    ],
  }
}

function cell(view: ReturnType<typeof resolvedKeys>, spaceId: string, name: string) {
  const row = view.groups
    .find((group) => group.spaceId === spaceId)
    ?.rows.find((candidate) => candidate.name === name)
  return row?.cells[column]
}

test('a project copy wins over the account copy, which resolves everywhere else', () => {
  const view = resolvedKeys(data(null))
  expect(cell(view, teamId, 'own')).toMatchObject({ kind: 'own-project', hint: 'proj' })
  expect(cell(view, teamId, 'shared')).toMatchObject({ kind: 'account', hint: 'acct' })
  expect(cell(view, otherId, 'other')).toMatchObject({ kind: 'account', hint: 'acct' })
  expect(view.groups.map((group) => group.spaceId)).not.toContain(personalId)
  expect(view.account).toMatchObject([{ reach: 'all', configuredReach: 'all' }])
})

test('effective reach names only the spaces where a project resolves the account copy', () => {
  const view = resolvedKeys(data([teamId]))
  expect(cell(view, otherId, 'other')).toMatchObject({ kind: 'none' })
  expect(view.account).toMatchObject([{ reach: ['Team'], configuredReach: ['Team'] }])
  const overridden = resolvedKeys({
    ...data([teamId]),
    spaces: data([teamId]).spaces.map(
      (entry): Space =>
        entry.id === teamId ? space(teamId, 'Team', entry.secrets, [teamOwn]) : entry,
    ),
  })
  expect(overridden.account).toMatchObject([{ reach: [], configuredReach: ['Team'] }])
})

function unread(id: string, name: string): Space {
  return { id, name, secrets: [], preferences: [], projects: [], error: 'refused' }
}

test('a space that could not be read shows no rows and does not narrow the account reach', () => {
  const failed = (entry: Space): Space => (entry.id === otherId ? unread(otherId, 'Other') : entry)
  const view = resolvedKeys({ ...data(null), spaces: data(null).spaces.map(failed) })
  expect(view.groups.find((group) => group.spaceId === otherId)).toMatchObject({
    error: 'refused',
    rows: [],
  })
  expect(view.account).toMatchObject([{ reach: 'all' }])
  const personalFailed = resolvedKeys({
    ...data(null),
    spaces: data(null).spaces.map((entry) =>
      entry.id === personalId ? unread(personalId, 'Personal') : entry,
    ),
  })
  expect(personalFailed).toMatchObject({ accountError: 'refused', account: [] })
})
