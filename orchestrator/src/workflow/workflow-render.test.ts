import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { renderWorkflowComposition, renderWorkflowStep } from './workflow-render.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { composeWorkflow, getWorkflowStep, promoteWorkflow, setWorkflow } from './workflows.ts'

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({ gate: 'bun run check', trunk: 'develop', docs: { protocol: 'orch-docs' } }),
  )
  return d
}

const args = { key: 'DEV-821', branch: 'DEV-821-work', worktree: '/tmp/work' }

describe('workflow rendering', () => {
  test('a composed mode tells the agent how to fetch and finish every step', () => {
    const rendered = renderWorkflowComposition(
      composeWorkflow('ship', 'fixture', 'default', args, database()),
    )

    expect(rendered).toContain(
      'Rebase, independently review, triage, fix, merge by pull request, and close a task.',
    )
    expect(rendered).toContain('`get_workflow_step`')
    expect(rendered).toContain('`orch workflow step ship rebase')
    expect(rendered).toContain('project "fixture"')
    expect(rendered).toContain('mode "default"')
    expect(rendered).toContain(`args ${JSON.stringify(args)}`)
    expect(rendered).toContain('--arg key=DEV-821')
    expect(rendered).toContain('step 1, rebase')
  })

  test('a composition needing a mode asks for one without the driving contract', () => {
    const d = database()
    const draft = setWorkflow(
      'choose',
      {
        title: 'Choose',
        description: 'Choose a path.',
        arguments: [],
        modes: [
          { slug: 'one', title: 'One', entry: 'First?', steps: ['lens'] },
          { slug: 'two', title: 'Two', entry: 'Second?', steps: ['lens'] },
        ],
      },
      'test fixture',
      'test',
      d,
    )
    promoteWorkflow('choose', draft.n, 'publish', 'test', d)

    const rendered = renderWorkflowComposition(
      composeWorkflow('choose', 'fixture', undefined, {}, d),
    )
    expect(rendered).toContain(
      'Choose a mode by answering its question, then compose again with that mode.',
    )
    expect(rendered).not.toContain('Work the numbered steps below')
    expect(rendered).not.toContain('Reading a step line:')
    const lastInEveryMode = getWorkflowStep('choose', 'fixture', 'lens', args, d)
    expect(lastInEveryMode.next).toBeNull()
    expect(renderWorkflowStep(lastInEveryMode)).toEndWith(
      "This is the last step of choose in every mode that contains it. The workflow is finished when this step's floor is met.",
    )
  })

  test('an argument value with a space is quoted in the generated command', () => {
    const rendered = renderWorkflowComposition(
      composeWorkflow(
        'ship',
        'fixture',
        'default',
        { ...args, worktree: "/tmp/my work's" },
        database(),
      ),
    )
    expect(rendered).toContain(`--arg 'worktree=/tmp/my work'\\''s'`)
    expect(rendered).toContain('--arg key=DEV-821 ')
  })

  test('a composition missing required arguments names them instead of the contract', () => {
    const rendered = renderWorkflowComposition(
      composeWorkflow('ship', 'fixture', 'default', {}, database()),
    )
    expect(rendered).toContain('missing required arguments: key, branch, worktree')
    expect(rendered).not.toContain('Work the numbered steps below')
    expect(rendered).not.toContain('Choose a mode')
  })

  test('step pointers name the successor, the selected-mode end, and an ambiguous successor', () => {
    const d = database()
    expect(
      renderWorkflowStep(
        getWorkflowStep('ship', 'fixture', 'rebase', args, d, { mode: 'default' }),
      ),
    ).toEndWith(
      "Next: when this step's floor is met, close it with `next_workflow_step` (MCP) or `orch workflow next`, giving a one-line note of how the floor was met; that serves step 2 lens — Run independent review lenses.",
    )
    expect(
      renderWorkflowStep(getWorkflowStep('ship', 'fixture', 'close', args, d, { mode: 'default' })),
    ).toEndWith(
      "This is the last step of ship (default). The workflow is finished when this step's floor is met.",
    )

    const draft = setWorkflow(
      'forked-next',
      {
        title: 'Forked next',
        description: 'Test divergent successors.',
        arguments: [],
        modes: [
          { slug: 'one', title: 'One', entry: 'First?', steps: ['score', 'lens'] },
          { slug: 'two', title: 'Two', entry: 'Second?', steps: ['score', 'complete'] },
        ],
      },
      'test fixture',
      'test',
      d,
    )
    promoteWorkflow('forked-next', draft.n, 'publish', 'test', d)
    expect(renderWorkflowStep(getWorkflowStep('forked-next', 'fixture', 'score', {}, d))).toEndWith(
      "Next: when this step's floor is met, close it with `next_workflow_step` (MCP) or `orch workflow next`, giving a one-line note of how the floor was met; that serves the following step from the workflow's step list.",
    )
  })
})
