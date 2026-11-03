import { describe, expect, test } from 'bun:test'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { decideCursorArguments } from './workflow-cursor-arguments.ts'
import { closeStep, context, database } from './workflow-cursor-test.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

describe('workflow cursor arguments', () => {
  test('next persists a rebound argument and renders it in the following step', () => {
    const d = database()
    const currentCatalogue = productionStepCatalogue(d).definition
    const catalogueDraft = setStepCatalogueLocal(
      {
        ...currentCatalogue,
        steps: currentCatalogue.steps.map((step) =>
          step.slug === 'rebase'
            ? { ...step, body: 'Rebase the reopened tree at {{worktree}}.' }
            : step,
        ),
      },
      'rebind fixture',
      'test',
      d,
    )
    promoteStepCatalogueLocal(catalogueDraft.n, 'publish rebind fixture', 'test', d)
    const draft = setWorkflowLocal(
      'rebind-fixture',
      {
        title: 'Rebind fixture',
        description: 'Exercises cursor argument rebinding.',
        arguments: [
          { name: 'key', required: true, description: 'Task key.' },
          {
            name: 'worktree',
            required: true,
            rebind: true,
            description: 'Worktree path.',
          },
          { name: 'branch', required: false, description: 'Review branch.' },
        ],
        modes: [
          {
            slug: 'default',
            title: 'Default',
            default: true,
            steps: ['lens', 'rebase'],
          },
        ],
      },
      'test fixture',
      'test',
      d,
    )
    promoteWorkflowLocal('rebind-fixture', draft.n, 'test fixture', 'test', d)
    composeWorkflowWithCursor(
      'rebind-fixture',
      'fixture',
      'default',
      { key: 'DEV-822', worktree: '/tmp/old' },
      context,
      d,
      {},
      {},
    )

    const next = closeStep(
      'rebind-fixture',
      'fixture',
      'default',
      { key: 'DEV-822', worktree: '/tmp/new' },
      'reviewed',
      context,
      d,
    )
    expect(next).toContain('Rebase the reopened tree at /tmp/new.')
    expect(next).not.toContain('/tmp/old')
    const row = d.query('SELECT args,closed FROM workflow_cursor').get() as {
      args: string
      closed: string
    }
    expect(JSON.parse(row.args).worktree).toBe('/tmp/new')
    expect(JSON.parse(row.closed)).toEqual([
      expect.objectContaining({
        event: 'argument-rebound',
        name: 'worktree',
        oldValue: '/tmp/old',
        newValue: '/tmp/new',
      }),
      expect.objectContaining({ n: 1, slug: 'lens', note: 'reviewed' }),
    ])
  })

  test('late cursor arguments merge into empty slots and conflicting values refuse', () => {
    const none = new Set<string>()
    expect(decideCursorArguments({ key: 'DEV-822' }, { branch: 'DEV-822-work' }, none)).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', branch: 'DEV-822-work' },
      rebindings: [],
    })
    expect(
      decideCursorArguments({ key: 'DEV-822', branch: ' ' }, { branch: 'work' }, none),
    ).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', branch: 'work' },
      rebindings: [],
    })
    expect(
      decideCursorArguments(
        { key: 'DEV-822', worktree: '/tmp/old' },
        { worktree: '/tmp/new' },
        new Set(['worktree']),
      ),
    ).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', worktree: '/tmp/new' },
      rebindings: [{ name: 'worktree', oldValue: '/tmp/old', newValue: '/tmp/new' }],
    })
    expect(
      decideCursorArguments(
        { key: 'DEV-822', branch: 'DEV-822-old' },
        { branch: 'DEV-822-new' },
        new Set(['branch']),
        true,
      ),
    ).toEqual({
      action: 'refuse',
      kind: 'compose-branch',
      storedBranch: 'DEV-822-old',
      suppliedBranch: 'DEV-822-new',
    })
    expect(
      decideCursorArguments(
        { key: 'DEV-822', branch: 'DEV-822-work' },
        { branch: ' DEV-822-work ' },
        new Set(['branch']),
        true,
      ),
    ).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', branch: ' DEV-822-work ' },
      rebindings: [{ name: 'branch', oldValue: 'DEV-822-work', newValue: ' DEV-822-work ' }],
    })
    expect(
      decideCursorArguments(
        { key: 'DEV-822', branch: 'DEV-822-work' },
        { branch: 'DEV-999-work' },
        none,
      ),
    ).toEqual({
      action: 'refuse',
      reason:
        'workflow argument "branch" conflicts with the cursor: stored value "DEV-822-work", supplied value "DEV-999-work"',
    })
    expect(decideCursorArguments({ key: 'DEV-822' }, { key: 'DEV-999' }, new Set(['key']))).toEqual(
      {
        action: 'refuse',
        reason:
          'workflow argument "key" conflicts with the cursor: stored value "DEV-822", supplied value "DEV-999"',
      },
    )
    expect(decideCursorArguments({}, { key: 'DEV-822' }, none)).toEqual({
      action: 'merge',
      args: {},
      rebindings: [],
    })
  })
})
