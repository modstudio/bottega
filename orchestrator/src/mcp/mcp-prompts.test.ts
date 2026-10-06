import { afterEach, describe, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { removeProject, upsertProject } from '../project/projects.ts'
import { promoteWorkflow, setWorkflow, type WorkflowDefinition } from '../workflow/workflows.ts'
import { createDocsMcpServer } from './mcp.ts'
import { bindWorkflowPromptArguments, workflowPromptDefinitions } from './mcp-prompts.ts'

const workflow = (
  slug: string,
  arguments_: WorkflowDefinition['arguments'],
): { slug: string; definition: WorkflowDefinition } => ({
  slug,
  definition: {
    title: 'Ship task',
    description: 'Ship one task.',
    arguments: arguments_,
    modes: [
      { slug: 'fast', title: 'Fast', default: true, steps: ['implement'] },
      { slug: 'careful', title: 'Careful', steps: ['plan', 'implement'] },
    ],
  },
})

describe('workflow prompt definitions', () => {
  test('declared-argument and mode-list mutation: retains every argument and mode, naming the required ones', () => {
    const [prompt] = workflowPromptDefinitions([
      workflow('ship-task', [
        { name: 'key', description: 'Task key.', required: true },
        { name: 'note', description: 'Optional note.', required: false },
      ]),
    ])

    expect(prompt?.arguments).toEqual([
      {
        name: 'mode',
        description:
          'Workflow mode slug. One of: fast, careful. Omit to use the default mode, or to be asked which mode to run when the workflow has none.',
      },
      {
        name: 'project',
        description:
          "Registered project name. Omit to use the project that owns the server's working directory.",
      },
      {
        name: 'autonomy',
        description: 'Comma-separated session autonomy key=value overrides.',
      },
      {
        name: 'key',
        description:
          'Task key. Required by the workflow; if omitted, the composition names it as missing.',
      },
      { name: 'note', description: 'Optional note.' },
    ])
  })

  test('prompt-name mutation: uses workflow slugs unchanged', () => {
    expect(workflowPromptDefinitions([workflow('ship-task', [])])[0]?.name).toBe('ship-task')
  })
})

describe('workflow prompt argument binding', () => {
  const definition: WorkflowDefinition = {
    title: 'Plan task',
    description: 'Plan one task.',
    arguments: [{ name: 'key', description: 'Task key.', required: false }],
    modes: ['feature', 'fix', 'chore', 'intake'].map((slug) => ({
      slug,
      title: slug,
      steps: ['plan'],
    })),
  }
  const isProject = (name: string) => name === 'starship'

  const cases: {
    received: Record<string, string>
    expected: ReturnType<typeof bindWorkflowPromptArguments>
  }[] = [
    {
      received: { mode: 'STAR-4291' },
      expected: { args: { key: 'STAR-4291' }, reread: ['read "STAR-4291" as key'] },
    },
    {
      received: { mode: 'feature', project: 'STAR-4291' },
      expected: {
        mode: 'feature',
        args: { key: 'STAR-4291' },
        reread: ['read "STAR-4291" as key'],
      },
    },
    {
      received: { mode: 'STAR-4291', project: 'feature' },
      expected: {
        mode: 'feature',
        args: { key: 'STAR-4291' },
        reread: ['read "STAR-4291" as key', 'read "feature" as mode'],
      },
    },
    {
      received: { mode: 'key=STAR-4291' },
      expected: {
        args: { key: 'STAR-4291' },
        reread: ['read "key=STAR-4291" as key'],
      },
    },
    {
      received: { mode: 'feature', project: 'starship', key: 'STAR-4291' },
      expected: {
        mode: 'feature',
        project: 'starship',
        args: { key: 'STAR-4291' },
        reread: [],
      },
    },
  ]

  test.each(cases)('binds $received', ({ received, expected }) => {
    expect(bindWorkflowPromptArguments(definition, received, isProject)).toEqual(expected)
  })

  test('refuses a token when no declared argument remains and names the remedy', () => {
    const result = bindWorkflowPromptArguments(
      definition,
      { mode: 'STAR-4291', project: 'STAR-4292' },
      isProject,
    )

    expect(result).toHaveProperty('refusal')
    if (!('refusal' in result)) throw new Error('expected binding refusal')
    expect(result.refusal).toContain('STAR-4292')
    expect(result.refusal).toContain('feature, fix, chore, intake')
    expect(result.refusal).toContain('key')
    expect(result.refusal).toContain('key=STAR-4292')
  })

  test('leaves the default mode unset when a positional token binds the first argument', () => {
    const result = bindWorkflowPromptArguments(
      {
        ...definition,
        arguments: ['key', 'branch', 'worktree'].map((name) => ({
          name,
          description: name,
          required: false,
        })),
        modes: [{ slug: 'default', title: 'Default', default: true, steps: ['plan'] }],
      },
      { mode: 'DEV-1' },
      isProject,
    )

    expect(result).toEqual({ args: { key: 'DEV-1' }, reread: ['read "DEV-1" as key'] })
  })
})

describe('workflow prompts on the wire', () => {
  afterEach(() => {
    removeProject('prompt-fixture')
  })

  const connected = async () => {
    const server = createDocsMcpServer()
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'prompt-test', version: '1' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return client
  }

  const installPlanTask = () => {
    const slug = 'plan-task'
    const draft = setWorkflow(
      slug,
      {
        title: 'Plan a task',
        description: 'Plan work.',
        arguments: [{ name: 'key', required: false, description: 'Task key.' }],
        modes: ['feature', 'fix', 'chore', 'intake'].map((mode) => ({
          slug: mode,
          title: mode[0]!.toUpperCase() + mode.slice(1),
          entry: `Choose ${mode}?`,
          steps: ['score'],
        })),
      },
      'test plan-task prompt',
      'test',
    )
    promoteWorkflow(slug, draft.n, 'publish test plan-task prompt', 'test')
  }

  test('advertised-requiredness mutation: a workflow-required argument reaches the client optional and described', async () => {
    const client = await connected()
    const { prompts } = await client.listPrompts()
    const key = prompts
      .find((prompt) => prompt.name === 'fix-defect')
      ?.arguments?.find((argument) => argument.name === 'key')

    expect(key?.required).toBe(false)
    expect(key?.description).toContain('Required by the workflow')
  })

  test('blank-argument mutation: blank values count as omitted, so composition asks for the missing argument', async () => {
    upsertProject({
      name: 'prompt-fixture',
      path: process.cwd(),
      stack: 'node',
      settings: { gate: 'true', docs: { protocol: 'orch-docs' } },
    })
    const client = await connected()
    const result = await client.getPrompt({
      name: 'fix-defect',
      arguments: { mode: '', project: '', key: ' ' },
    })

    expect(result.messages[0]?.content).toMatchObject({
      text: expect.stringContaining('- key: The filed task key.'),
    })
  })

  test('a prompt with no default mode lists its arguments and exact next calls', async () => {
    const slug = 'prompt-mode-chooser'
    upsertProject({
      name: 'prompt-fixture',
      path: process.cwd(),
      stack: 'node',
      settings: { gate: 'true', docs: { protocol: 'orch-docs' } },
    })
    const draft = setWorkflow(
      slug,
      {
        title: 'Choose prompt mode',
        description: 'Exercise the mode chooser prompt.',
        arguments: [{ name: 'key', required: false, description: 'Existing task key.' }],
        modes: [
          { slug: 'feature', title: 'Feature', entry: 'Add behavior?', steps: ['score'] },
          { slug: 'fix', title: 'Fix', entry: 'Correct behavior?', steps: ['score'] },
        ],
      },
      'test prompt mode chooser',
      'test',
    )
    promoteWorkflow(slug, draft.n, 'publish test prompt', 'test')
    const client = await connected()
    const result = await client.getPrompt({
      name: slug,
      arguments: { project: 'prompt-fixture' },
    })
    const text = (result.messages[0]!.content as { text: string }).text

    expect(text).toContain('No mode is chosen yet.')
    expect(text).toContain('get it from the operator as a task key or a description')
    expect(text).toContain('- key (optional): Existing task key.')
    expect(text).toContain('MCP `compose_workflow` or `get_workflow_step` with `mode`')
    expect(text).toContain(
      `CLI \`orch workflow compose ${slug} --project prompt-fixture --mode <mode>\``,
    )
    expect(text).not.toContain('facts: {}')
  })

  test('plan-task rereads a positional key and carries it through the mode menu', async () => {
    upsertProject({
      name: 'prompt-fixture',
      path: process.cwd(),
      stack: 'node',
      settings: { gate: 'true', docs: { protocol: 'orch-docs' } },
    })
    installPlanTask()
    const client = await connected()
    const result = await client.getPrompt({
      name: 'plan-task',
      arguments: { mode: 'STAR-4291' },
    })
    const text = (result.messages[0]!.content as { text: string }).text

    expect(text.startsWith('read "STAR-4291" as key\n')).toBe(true)
    expect(text).toContain('No mode is chosen yet.')
    expect(text).toContain('args {"key":"STAR-4291"}')
    expect(text).toContain('--arg key=STAR-4291')
  })

  test('plan-task leaves a correct named map unchanged', async () => {
    upsertProject({
      name: 'prompt-fixture',
      path: process.cwd(),
      stack: 'node',
      settings: { gate: 'true', docs: { protocol: 'orch-docs' } },
    })
    installPlanTask()
    const client = await connected()
    const result = await client.getPrompt({
      name: 'plan-task',
      arguments: { mode: 'feature', project: 'prompt-fixture', key: 'STAR-4291' },
    })
    const text = (result.messages[0]!.content as { text: string }).text

    expect(text.startsWith('read "')).toBe(false)
    expect(text).toContain('Plan a task — Feature')
    expect(text).toContain('args {"key":"STAR-4291"}')
  })
})
