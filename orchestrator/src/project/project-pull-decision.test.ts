import { describe, expect, test } from 'bun:test'
import type { RecordProject } from '../../../shared/record-project-contract.ts'
import { decideProjectRegisterPull } from './project-pull-decision.ts'
import type { Project } from './projects.ts'

function local(overrides: Partial<Project> = {}): Project {
  return {
    recordId: 'project-a',
    name: 'local-name',
    path: '/machine/local-name',
    stack: null,
    canon: false,
    retiredAt: null,
    settings: {
      trunk: 'old',
      gate: 'old gate',
      checks: { spelling: true },
      space: 'alpha',
    },
    ...overrides,
  }
}

function hosted(overrides: Partial<RecordProject> = {}): RecordProject {
  return {
    id: 'project-a',
    spaceId: 'space-a',
    spaceName: 'Alpha',
    name: 'hosted-name',
    keyPrefixes: [],
    stack: 'typescript',
    managedContext: false,
    landingBranch: 'main',
    color: null,
    colorDark: null,
    retiredAt: '2026-11-04T12:00:00.000Z',
    canon: true,
    settings: { trunk: 'main', workerCheck: 'bun test' },
    ...overrides,
  }
}

describe('decideProjectRegisterPull', () => {
  test('mirrors hosted fields and settings while preserving machine-local values and path', () => {
    expect(decideProjectRegisterPull([local()], [hosted()])).toEqual([
      {
        kind: 'update',
        previousName: 'local-name',
        previousTrunk: 'old',
        nextTrunk: 'main',
        project: {
          recordId: 'project-a',
          name: 'hosted-name',
          path: '/machine/local-name',
          stack: 'typescript',
          canon: true,
          retiredAt: '2026-11-04T12:00:00.000Z',
          settings: {
            trunk: 'main',
            workerCheck: 'bun test',
            checks: { spelling: true },
            space: 'alpha',
          },
        },
      },
    ])
  })

  test('ignores a hosted row without a linked local identity', () => {
    expect(decideProjectRegisterPull([local()], [hosted({ id: 'hosted-only' })])).toEqual([])
  })

  test('skips a hosted rename that collides with another local row', () => {
    const collision = local({ recordId: 'project-b', name: 'hosted-name' })
    expect(decideProjectRegisterPull([local(), collision], [hosted()])).toEqual([
      {
        kind: 'skip',
        project: 'local-name',
        reason:
          'project local-name cannot mirror hosted name hosted-name because it collides with local project hosted-name',
      },
    ])
  })

  test('skips invalid merged settings and names their problems', () => {
    const [decision] = decideProjectRegisterPull([local()], [hosted({ settings: { trunk: 42 } })])
    expect(decision).toMatchObject({ kind: 'skip', project: 'local-name' })
    expect(decision?.kind === 'skip' ? decision.reason : '').toContain(
      'trunk: Invalid input: expected string, received number',
    )
  })

  test('un-retires from the hosted lifecycle', () => {
    const retired = local({ retiredAt: '2026-11-01T12:00:00.000Z' })
    const [decision] = decideProjectRegisterPull(
      [retired],
      [
        hosted({
          name: retired.name,
          stack: retired.stack,
          canon: retired.canon,
          retiredAt: null,
          settings: retired.settings,
        }),
      ],
    )
    expect(decision).toMatchObject({ kind: 'update', project: { retiredAt: null } })
  })

  test('reports no change for an identical linked row', () => {
    const project = local()
    expect(
      decideProjectRegisterPull(
        [project],
        [
          hosted({
            name: project.name,
            stack: project.stack,
            canon: project.canon,
            retiredAt: project.retiredAt,
            settings: project.settings,
          }),
        ],
      ),
    ).toEqual([{ kind: 'no-change', project: 'local-name' }])
  })
})
