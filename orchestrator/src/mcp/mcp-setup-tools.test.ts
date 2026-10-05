import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import type { SetupActionResult } from '../setup/setup-apply.ts'
import type { SetupPlan, SetupProposal, SetupQuestion } from '../setup/setup-engine.ts'
import type { SetupAction } from '../setup/setup-planner.ts'
import { createSetupService } from '../setup/setup-service.ts'
import { registerSetupTools } from './mcp-setup-tools.ts'

const folder = process.cwd()
const priorRunId = process.env.ORCH_RUN_ID
const priorDepth = process.env.ORCH_DEPTH

beforeEach(() => {
  delete process.env.ORCH_RUN_ID
  delete process.env.ORCH_DEPTH
})

afterEach(() => {
  if (priorRunId === undefined) delete process.env.ORCH_RUN_ID
  else process.env.ORCH_RUN_ID = priorRunId
  if (priorDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorDepth
})

const question: SetupQuestion = {
  id: 'project:alpha:prefix',
  question: 'Which task prefix should alpha use?',
  why: 'The detected prefix has more than one reasonable spelling.',
  recommendation: 'ALPHA',
  options: [
    { id: 'ALPHA', label: 'Use ALPHA', why: 'Matches the repository name.' },
    { id: 'ALT', label: 'Use ALT', why: 'Matches the package name.' },
  ],
}

const trunkQuestion: SetupQuestion = {
  id: 'project:alpha:trunk',
  question: 'Which trunk setting should alpha use?',
  why: 'The checked-out branch and remote default disagree.',
  recommendation: 'unset',
  options: [
    {
      id: 'unset',
      label: 'Leave trunk unset',
      why: 'The register requires trunk to be the checked-out branch, and the remote default is main.',
      effect: { trunk: null },
    },
    {
      id: 'current',
      label: 'Use the current branch feature as trunk',
      why: 'The current symbolic HEAD is the only branch the register can accept now.',
      effect: { trunk: 'feature' },
    },
  ],
}

function proposal(name: string, current: SetupProposal['current'] = null): SetupProposal {
  return {
    repository: { path: `${folder}/${name}` } as SetupProposal['repository'],
    current,
    project: { name, path: `${folder}/${name}`, stack: 'typescript', settings: {} },
    prefixQuestionId: name === 'alpha' ? question.id : null,
    trunkQuestionId: null,
    recipeQuestionId: null,
    recipeActivationAnswer: null,
    recipeContent: null,
  }
}

function fixturePlan(
  proposals: SetupProposal[] = [
    proposal('alpha'),
    proposal('ready', {
      name: 'ready',
      path: `${folder}/ready`,
      stack: 'typescript',
      settings: {},
    } as SetupProposal['current']),
  ],
): SetupPlan {
  return {
    facts: { machine: {} as SetupPlan['facts']['machine'], repositories: [] },
    proposals,
    registrations: [],
    questions: [question],
    notices: [{ message: 'One harness is signed out.', fix: 'Sign in to that harness.' }],
  }
}

async function withClient<T>(
  service: ReturnType<typeof createSetupService>,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = new McpServer({ name: 'orch-setup-test', version: '1.0.0' })
  registerSetupTools(server, service)
  const client = new Client({ name: 'orch-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

function serviceFor(
  plan: SetupPlan,
  applyActions: (actions: SetupAction[]) => Promise<SetupActionResult[]> = async (actions) =>
    actions.map((action) => ({ ...action, status: 'applied', message: null })),
) {
  return createSetupService({ plan: async () => plan, applyActions })
}

describe('setup MCP tools', () => {
  test('the CLI-only recommended apply plans once and applies that plan recommendations', async () => {
    let planCalls = 0
    const applied: SetupAction[][] = []
    const service = createSetupService({
      plan: async () => {
        planCalls += 1
        return fixturePlan()
      },
      applyActions: async (actions) => {
        applied.push(actions)
        return actions.map((action) => ({ ...action, status: 'applied', message: null }))
      },
    })

    const outcome = await service.applyRecommended([folder])

    expect(planCalls).toBe(1)
    expect(applied).toHaveLength(1)
    expect(outcome.actions[0]).toMatchObject({
      kind: 'add',
      name: 'alpha',
      settings: { keyPrefixes: ['ALPHA'] },
    })
  })

  test('setup_plan returns ruling-shaped questions and only machine-changing actions', async () => {
    const result = await withClient(serviceFor(fixturePlan()), (client) =>
      client.callTool({ name: 'setup_plan', arguments: { folders: [folder] } }),
    )

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      questions: [question],
      notices: [{ message: 'One harness is signed out.', fix: 'Sign in to that harness.' }],
      changes: [`Add project alpha (${folder}/alpha)`],
    })
  })

  test('setup_plan projects engine trunk options onto the public shape without effects', async () => {
    const plan = fixturePlan()
    plan.questions = [trunkQuestion]
    plan.proposals[0]!.prefixQuestionId = null
    plan.proposals[0]!.trunkQuestionId = trunkQuestion.id
    const result = await withClient(serviceFor(plan), (client) =>
      client.callTool({ name: 'setup_plan', arguments: { folders: [folder] } }),
    )

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      questions: [
        {
          id: trunkQuestion.id,
          options: [
            { id: 'unset', label: 'Leave trunk unset', why: trunkQuestion.options[0]!.why },
            {
              id: 'current',
              label: 'Use the current branch feature as trunk',
              why: trunkQuestion.options[1]!.why,
            },
          ],
        },
      ],
    })
    expect(result.structuredContent).not.toHaveProperty('questions.0.options.0.effect')
    expect(result.structuredContent).not.toHaveProperty('questions.0.options.1.effect')
  })

  test('setup_apply recomputes and applies exactly the actions derived from complete answers', async () => {
    const applied: SetupAction[][] = []
    const service = serviceFor(fixturePlan(), async (actions) => {
      applied.push(actions)
      return actions.map((action) => ({ ...action, status: 'applied', message: null }))
    })

    const result = await withClient(service, (client) =>
      client.callTool({
        name: 'setup_apply',
        arguments: { folders: [folder], answers: { [question.id]: 'ALT' } },
      }),
    )

    expect(result.isError).not.toBe(true)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toEqual([
      expect.objectContaining({ kind: 'add', name: 'alpha', settings: { keyPrefixes: ['ALT'] } }),
      expect.objectContaining({ kind: 'unchanged', name: 'ready' }),
    ])
    expect(result.structuredContent).toEqual({
      actions: [
        { line: `Add project alpha (${folder}/alpha)`, status: 'applied', message: null },
        { line: `Project ready (${folder}/ready)`, status: 'applied', message: null },
      ],
      refused: false,
    })
  })

  test.each([
    ['a missing answer', {}],
    ['an unknown question id', { [question.id]: 'ALPHA', unknown: 'value' }],
    ['an option the question does not offer', { [question.id]: 'NOPE' }],
  ])('setup_apply refuses %s and applies nothing', async (_name, answers) => {
    let applyCalls = 0
    const service = serviceFor(fixturePlan(), async () => {
      applyCalls += 1
      return []
    })

    const result = await withClient(service, (client) =>
      client.callTool({ name: 'setup_apply', arguments: { folders: [folder], answers } }),
    )

    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]?.text).toContain('call setup_plan again')
    expect(applyCalls).toBe(0)
  })

  test('setup_apply reports refusal and later actions as not attempted', async () => {
    const service = serviceFor(fixturePlan(), async (actions) => [
      { ...actions[0]!, status: 'refused', message: 'register rejected alpha' },
      { ...actions[1]!, status: 'not-attempted', message: null },
    ])

    const result = await withClient(service, (client) =>
      client.callTool({
        name: 'setup_apply',
        arguments: { folders: [folder], answers: { [question.id]: 'ALPHA' } },
      }),
    )

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      actions: [{ status: 'refused' }, { status: 'not-attempted' }],
      refused: true,
    })
  })

  test.each(['setup_plan', 'setup_apply'])('%s refuses a worker-marked caller', async (name) => {
    process.env.ORCH_RUN_ID = '123'
    const arguments_ =
      name === 'setup_plan'
        ? { folders: [folder] }
        : { folders: [folder], answers: { [question.id]: 'ALPHA' } }

    const result = await withClient(serviceFor(fixturePlan()), (client) =>
      client.callTool({ name, arguments: arguments_ }),
    )

    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]?.text).toContain('worker-marked callers')
  })

  test.each(['setup_plan', 'setup_apply'])('%s refuses invalid folder inputs', async (name) => {
    for (const [folders, offending] of [
      [['relative-folder'], 'relative-folder'],
      [[], '[]'],
      [[`${folder}/setup-tools-path-that-does-not-exist`], 'setup-tools-path-that-does-not-exist'],
    ] as const) {
      const arguments_ =
        name === 'setup_plan' ? { folders } : { folders, answers: { [question.id]: 'ALPHA' } }

      const result = await withClient(serviceFor(fixturePlan()), (client) =>
        client.callTool({ name, arguments: arguments_ }),
      )

      expect(result.isError).toBe(true)
      expect((result.content as { text: string }[])[0]?.text).toContain(offending)
    }
  })
})
