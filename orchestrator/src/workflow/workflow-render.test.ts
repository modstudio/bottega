import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import { type FloorKind, floorGuidance, floorKinds } from './workflow-floor.ts'
import { renderWorkflowComposition, renderWorkflowStep } from './workflow-render.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import {
  composeWorkflow,
  getWorkflowStep,
  promoteWorkflowLocal,
  setWorkflowLocal,
} from './workflows.ts'

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query(
    'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
  ).run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'develop',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
})

const args = { key: 'DEV-821', branch: 'DEV-821-work', worktree: '/tmp/work' }

describe('workflow rendering', () => {
  test('renders conditional composition entries and a step close outcome contract', () => {
    const d = database()
    const current = productionStepCatalogue(d).definition
    const catalogue = setStepCatalogueLocal(
      {
        ...current,
        steps: current.steps.map((step) =>
          step.slug === 'lens'
            ? { ...step, body: 'Review the work.', outcomes: ['needed', 'clear'] }
            : step,
        ),
      },
      'render flow fixture',
      'test',
      d,
    )
    promoteStepCatalogueLocal(catalogue.n, 'publish', 'test', d)
    const draft = setWorkflowLocal(
      'render-flow',
      {
        title: 'Render flow',
        description: 'Render conditions.',
        arguments: [],
        modes: [
          {
            slug: 'default',
            title: 'Default',
            default: true,
            steps: [
              'lens',
              { step: 'score', when: { step: 'lens', outcome: ['needed', 'clear'] } },
            ],
          },
        ],
      },
      'render flow fixture',
      'test',
      d,
    )
    promoteWorkflowLocal('render-flow', draft.n, 'publish', 'test', d)
    expect(
      renderWorkflowComposition(composeWorkflow('render-flow', 'fixture', 'default', {}, d)),
    ).toContain('only when lens is needed or clear')
    expect(
      renderWorkflowStep(
        getWorkflowStep('render-flow', 'fixture', 'lens', {}, d, { mode: 'default' }),
      ),
    ).toContain('Choose one allowed outcome (needed, clear)')
    expect(
      renderWorkflowStep({
        ...getWorkflowStep('render-flow', 'fixture', 'lens', {}, d, { mode: 'default' }),
        rulingOutcomes: ['needed'],
        reenter: { to: 'score', outcome: 'needed' },
        pass: 2,
        flow: [{ slug: 'lens', outcome: 'needed' }],
      }),
    ).toContain('Flow so far: Pass 2, lens=needed')
    expect(
      renderWorkflowStep({
        ...getWorkflowStep('render-flow', 'fixture', 'lens', {}, d, { mode: 'default' }),
        rulingOutcomes: ['needed'],
        reenter: { to: 'score', outcome: 'needed' },
      }),
    ).toContain('Closing with needed stops for a ruling.')
    expect(
      renderWorkflowStep({
        ...getWorkflowStep('render-flow', 'fixture', 'lens', {}, d, { mode: 'default' }),
        reenter: { to: 'score', outcome: 'needed' },
      }),
    ).toContain(
      'Outcome needed returns to score automatically once; beyond that it needs a ruling.',
    )
    expect(
      renderWorkflowStep(
        getWorkflowStep('render-flow', 'fixture', 'lens', {}, d, { mode: 'default' }),
      ),
    ).toContain(
      'step 2 score — Score the lenses runs only when lens is needed or clear; otherwise closing skips it and serves the next eligible step.',
    )
  })
  test('every floor kind has generated evidence guidance', () => {
    expect(floorKinds.filter((kind) => !floorGuidance[kind]?.trim())).toEqual([])
    const d = database()
    expect(
      renderWorkflowStep(
        getWorkflowStep('flow', 'fixture', 'rebase', args, d, { mode: 'default' }),
      ),
    ).toContain(
      `Evidence for command-exit: run it with \`${PLATFORM_SLUG} workflow exec -- <command>\` and pass \`--artifact exec:<id>\`.`,
    )
    expect(
      renderWorkflowStep(getWorkflowStep('flow', 'fixture', 'lens', args, d, { mode: 'default' })),
    ).toContain(
      'Evidence for recorded-artifact: record or attach the artifact and pass `--artifact <doc:<scope>/<subject-or-_>/<slug> | doc:<UUID> | task:<KEY> | task:<KEY>#comment:<id> | run number | probe:<id> | exec:<id> | attached-text:<id>>`.',
    )
  })

  test('a composed mode tells the agent how to fetch and finish every step', () => {
    const rendered = renderWorkflowComposition(
      composeWorkflow('flow', 'fixture', 'default', args, database()),
    )

    expect(rendered).toContain('Exercises generic workflow behavior.')
    expect(rendered).toContain('`get_workflow_step`')
    expect(rendered).toContain(`${PLATFORM_SLUG} workflow step flow rebase`)
    expect(rendered).toContain('project "fixture"')
    expect(rendered).toContain('mode "default"')
    expect(rendered).toContain(`args ${JSON.stringify(args)}`)
    expect(rendered).toContain('--arg key=DEV-821')
    expect(rendered).toContain('step 1, rebase')
    expect(rendered).toContain('autonomy=auto(built-in)')
    expect(rendered).toContain('Worker questions: rulings=agent (built-in).')
    expect(rendered).toContain(
      'answer what the specification or canon settles; relay a design or product-direction question to the operator and answer it with --from-operator.',
    )
    expect(rendered).toContain(
      `At every autonomy, a genuine design or product-direction decision goes to the operator: record it with \`${PLATFORM_SLUG} workflow await\` and stop.`,
    )
  })

  test('a composition needing a mode asks for one without the driving contract', () => {
    const d = database()
    const draft = setWorkflowLocal(
      'choose',
      {
        title: 'Choose',
        description: 'Choose a path.',
        arguments: [
          { name: 'key', required: false, description: 'Existing task key.' },
          { name: 'branch', required: false, description: 'Review branch.' },
        ],
        modes: [
          { slug: 'one', title: 'One', entry: 'First?', steps: ['lens'] },
          { slug: 'two', title: 'Two', entry: 'Second?', steps: ['lens'] },
        ],
      },
      'test fixture',
      'test',
      d,
    )
    promoteWorkflowLocal('choose', draft.n, 'publish', 'test', d)

    const rendered = renderWorkflowComposition(
      composeWorkflow('choose', 'fixture', undefined, {}, d),
    )
    expect(rendered).toContain(
      'Choose a mode by answering its question, then compose again with that mode.',
    )
    expect(rendered).toContain('No mode is chosen yet.')
    expect(rendered).toContain('- key (optional): Existing task key.')
    expect(rendered).toContain(
      'If the work has not been supplied, get it from the operator as a task key or a description before choosing a mode.',
    )
    expect(rendered).toContain('MCP `compose_workflow` or `get_workflow_step` with `mode`')
    expect(rendered).toContain(
      `${PLATFORM_SLUG} workflow compose choose --project fixture --mode <mode>`,
    )
    expect(rendered).not.toContain('facts: {}')
    expect(rendered).not.toContain('Work the numbered steps below')
    expect(rendered).not.toContain('Reading a step line:')
    const lastInEveryMode = getWorkflowStep('choose', 'fixture', 'lens', args, d)
    expect(lastInEveryMode.next).toBeNull()
    expect(renderWorkflowStep(lastInEveryMode)).toEndWith(
      `Next: when this step's floor is met, close it with \`next_workflow_step\` (MCP) or \`${PLATFORM_SLUG} workflow next\`, giving a one-line note of how the floor was met; this is the last step of choose in every mode that contains it, and closing it finishes the workflow.`,
    )
  })

  test('an argument value with a space is quoted in the generated command', () => {
    const rendered = renderWorkflowComposition(
      composeWorkflow(
        'flow',
        'fixture',
        'default',
        { ...args, worktree: "/tmp/my work's" },
        database(),
      ),
    )
    expect(rendered).toContain(`--arg 'worktree=/tmp/my work'\\''s'`)
    expect(rendered).toContain('--arg key=DEV-821 ')
  })

  test('a composition missing required arguments stops to ask for them but keeps the step list', () => {
    const rendered = renderWorkflowComposition(
      composeWorkflow('flow', 'fixture', 'default', {}, database()),
    )
    expect(rendered.split('\n').slice(0, 5)).toEqual([
      'Fixture workflow — Default',
      'Worker questions: rulings=agent (built-in). answer what the specification or canon settles; relay a design or product-direction question to the operator and answer it with --from-operator.',
      'STOP. Do not start step 1. Ask the operator for each missing argument below, then compose again with them.',
      '- key: The task key.',
      '- branch: The branch.',
    ])
    expect(rendered).toContain('1. rebase — Rebase and verify')
    expect(rendered).not.toContain('Work the numbered steps below')
  })

  test('step pointers name the successor, the selected-mode end, and an ambiguous successor', () => {
    const d = database()
    expect(
      renderWorkflowStep(
        getWorkflowStep('flow', 'fixture', 'rebase', args, d, { mode: 'default' }),
      ),
    ).toContain(
      `Autonomy: auto (built-in) — meet this step's floor with command-exit evidence; a design or product-direction decision still goes to the operator (\`${PLATFORM_SLUG} workflow await\`).`,
    )
    expect(
      renderWorkflowStep(
        getWorkflowStep('flow', 'fixture', 'rebase', args, d, { mode: 'default' }),
      ),
    ).toEndWith(
      `Next: when this step's floor is met, close it with \`next_workflow_step\` (MCP) or \`${PLATFORM_SLUG} workflow next\`, giving a one-line note of how the floor was met; that serves step 2 lens — Run independent review lenses.`,
    )
    expect(
      renderWorkflowStep(getWorkflowStep('flow', 'fixture', 'close', args, d, { mode: 'default' })),
    ).toEndWith(
      `Next: when this step's floor is met, close it with \`next_workflow_step\` (MCP) or \`${PLATFORM_SLUG} workflow next\`, giving a one-line note of how the floor was met; this is the last step of flow (default), and closing it finishes the workflow.`,
    )

    const draft = setWorkflowLocal(
      'forked-next',
      {
        title: 'Forked next',
        description: 'Test divergent successors.',
        arguments: [
          { name: 'key', required: false, description: 'Task key.' },
          { name: 'branch', required: false, description: 'Review branch.' },
        ],
        modes: [
          { slug: 'one', title: 'One', entry: 'First?', steps: ['score', 'lens'] },
          { slug: 'two', title: 'Two', entry: 'Second?', steps: ['score', 'complete'] },
        ],
      },
      'test fixture',
      'test',
      d,
    )
    promoteWorkflowLocal('forked-next', draft.n, 'publish', 'test', d)
    expect(renderWorkflowStep(getWorkflowStep('forked-next', 'fixture', 'score', {}, d))).toEndWith(
      `Next: when this step's floor is met, close it with \`next_workflow_step\` (MCP) or \`${PLATFORM_SLUG} workflow next\`, giving a one-line note of how the floor was met; that serves the following step from the workflow's step list.`,
    )
  })

  test('autonomy offers self-ruling only when the step has a ruling floor', () => {
    const step = {
      slug: 'apply-findings',
      title: 'Apply review findings',
      body: 'Apply the accepted findings.',
      floor: ['command-exit', 'recorded-artifact'] as FloorKind[],
      expectedStatus: undefined,
      commandEvidence: undefined,
      job: null,
      autonomy: 'auto' as const,
      needs: [],
      resolvedAutonomy: { value: 'auto' as const, scope: 'built-in' },
      workflow: 'ship-task',
      version: 1,
      catalogueVersion: 1,
      project: 'fixture',
      mode: 'full',
      facts: {},
      next: null,
    }
    const evidenceRendered = renderWorkflowStep(step)
    expect(evidenceRendered).toContain(
      `Autonomy: auto (built-in) — meet this step's floor with command-exit or recorded-artifact evidence; a design or product-direction decision still goes to the operator (\`${PLATFORM_SLUG} workflow await\`).`,
    )
    expect(evidenceRendered).not.toContain('self_ruling')
    expect(evidenceRendered).not.toContain('--self-ruling')
    expect(evidenceRendered).not.toContain('rule yourself')

    const reviewEvidenceRendered = renderWorkflowStep({
      ...step,
      resolvedAutonomy: { value: 'review' as const, scope: 'project' },
    })
    expect(reviewEvidenceRendered).toContain(
      `Autonomy: review (project) — meet this step's floor with command-exit or recorded-artifact evidence; a design or product-direction decision still goes to the operator (\`${PLATFORM_SLUG} workflow await\`).`,
    )
    expect(reviewEvidenceRendered).not.toContain('self_ruling')
    expect(reviewEvidenceRendered).not.toContain('--self-ruling')
    expect(reviewEvidenceRendered).not.toContain('rule yourself')

    const rulingRendered = renderWorkflowStep({ ...step, floor: ['ruling'] })
    expect(rulingRendered).toContain('self_ruling')
    expect(rulingRendered).toContain('--self-ruling')
    expect(rulingRendered).toContain('rule yourself')

    const rulingOutcomeRendered = renderWorkflowStep({
      ...step,
      outcomes: ['needed', 'clear'],
      rulingOutcomes: ['needed'],
    })
    expect(rulingOutcomeRendered).toContain('for outcome needed, you may rule this step yourself')
    expect(rulingOutcomeRendered).toContain('--self-ruling')
  })

  test('ask autonomy wins when the step has no ruling floor', () => {
    const rendered = renderWorkflowStep({
      slug: 'merge-pr',
      title: 'Merge the pull request',
      body: 'Merge the admitted pull request.',
      floor: ['command-exit', 'recorded-artifact'],
      expectedStatus: undefined,
      commandEvidence: undefined,
      job: null,
      autonomy: 'auto',
      needs: [],
      resolvedAutonomy: { value: 'ask', scope: 'operator' },
      workflow: 'ship-task',
      version: 1,
      catalogueVersion: 1,
      project: 'fixture',
      mode: 'full',
      facts: {},
      next: null,
    })
    expect(rendered).toContain(
      `Autonomy: ask (operator) — stop and put the ruling to the operator; record the question with \`${PLATFORM_SLUG} workflow await\`. The operator's answer authorizes the action; then close this step with command-exit or recorded-artifact evidence.`,
    )
    expect(rendered).not.toContain('self_ruling')
    expect(rendered).not.toContain('--self-ruling')
    expect(rendered).not.toContain('rule yourself')
  })

  test('an operator-only ruling floor does not tell the agent to rule itself or pass self-ruling', () => {
    const rendered = renderWorkflowStep({
      slug: 'acceptance',
      title: "Check the task's acceptance criteria",
      body: 'Write a table of every criterion.',
      floor: ['recorded-artifact', 'ruling'],
      expectedStatus: undefined,
      commandEvidence: undefined,
      job: null,
      autonomy: 'auto',
      needs: [],
      operatorRuling: true,
      resolvedAutonomy: { value: 'auto', scope: 'built-in' },
      workflow: 'ship-task',
      version: 1,
      catalogueVersion: 1,
      project: 'fixture',
      mode: 'full',
      facts: {},
      next: { n: 11, slug: 'open-pr', title: 'Open the pull request' },
    })
    expect(rendered).toContain(
      `Autonomy: auto (built-in) — this step cannot be closed by an agent self-ruling; close with another floor's evidence, or put an operator ruling with \`${PLATFORM_SLUG} workflow await\` when that is the evidence you use.`,
    )
    expect(rendered).toContain(
      `Evidence for ruling: call \`await_workflow_ruling\` (or \`${PLATFORM_SLUG} workflow await\`), answer it with \`rule_workflow\`, then pass \`--ruling <the returned question id>\`.`,
    )
    expect(rendered).not.toContain('rule yourself')
    expect(rendered).not.toContain('self_ruling')
    expect(rendered).not.toContain('--self-ruling')
  })

  test('resolved close-task with tracker-transition and operatorRuling offers no ruling', () => {
    const rendered = renderWorkflowStep({
      slug: 'close-task',
      title: 'Close the task',
      body: "This run's close action is done.",
      floor: ['tracker-transition'],
      expectedStatus: undefined,
      commandEvidence: undefined,
      job: null,
      autonomy: 'auto',
      needs: [],
      operatorRuling: true,
      resolvedAutonomy: { value: 'auto', scope: 'built-in' },
      workflow: 'ship-task',
      version: 1,
      catalogueVersion: 1,
      project: 'fixture',
      mode: 'full',
      facts: {},
      next: null,
    })
    expect(rendered).toContain(
      `Autonomy: auto (built-in) — meet this step's floor with tracker-transition evidence; a design or product-direction decision still goes to the operator (\`${PLATFORM_SLUG} workflow await\`).`,
    )
    expect(rendered).not.toContain('put an operator ruling')
  })
})
