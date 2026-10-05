import { beforeEach, expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { ManagedContextPage, UserCanonSection } from '@/routes/context'
import { queryClient, trpc } from '@/trpc/client'

const doc = {
  id: 1,
  scope: 'canon' as const,
  subject: null,
  slug: 'preferences',
  title: 'Preferences',
  body: '# Prefer concise reports',
  delivery: 'inject' as const,
  revision: 'revision-1',
  created_at: '2026-09-25T12:00:00.000Z',
  updated_at: '2026-09-25T12:00:00.000Z',
}

function render() {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ManagedContextPage />
    </QueryClientProvider>,
  )
}

function seedBase() {
  queryClient.setQueryData(trpc.context.projects.queryOptions().queryKey, [
    { name: 'alpha', path: '/work/alpha', managedContext: true, worktreeNote: 'Serve this tree.' },
  ])
  queryClient.setQueryData(trpc.context.userCanon.list.queryOptions().queryKey, [doc])
  queryClient.setQueryData(
    trpc.context.userCanon.get.queryOptions({ slug: 'preferences' }).queryKey,
    doc,
  )
  const autonomyOptions = trpc.context.autonomy.get.queryOptions({ project: 'alpha' })
  type AutonomyData = Awaited<ReturnType<NonNullable<typeof autonomyOptions.queryFn>>>
  const autonomy: AutonomyData = {
    registered: true,
    project: 'alpha',
    rulings: { value: 'user', scope: 'hosted user' },
    shipTo: { value: 'trunk', scope: 'hosted user', landing: 'main', production: null },
    stages: [{ stage: 'review', agreed: true, value: 'review', scope: 'hosted user', steps: 2 }],
    text: 'Autonomy for alpha\nship to: trunk (merge into main) (hosted user)',
  }
  queryClient.setQueryData(autonomyOptions.queryKey, autonomy)
  queryClient.setQueryData(trpc.context.settings.get.queryOptions({ user: true }).queryKey, {
    target: { kind: 'user' },
    file: { path: '/home/operator/.claude/settings.json', exists: true },
    revision: 'revision-settings',
    settings: {
      permissions: { allow: ['Bash(orch result *)'], ask: [], deny: [] },
      hooks: [{ event: 'PreToolUse', matcher: 'Bash', fingerprint: '123456abcdef' }],
      envKeys: ['ORCH_TOKEN'],
    },
    drift: {
      rules: {
        allow: { added: [], removed: [] },
        ask: { added: [], removed: [] },
        deny: { added: [], removed: [] },
      },
      hooks: { added: [], removed: [] },
      envKeys: { added: [], removed: [] },
    },
    findings: [],
  })
}

beforeEach(() => queryClient.clear())

test('managed settings never renders an env value from a crafted payload', () => {
  seedBase()
  const options = trpc.context.settings.get.queryOptions({ user: true })
  const seeded = queryClient.getQueryData(options.queryKey)!
  queryClient.setQueryData(options.queryKey, {
    ...seeded,
    settings: { ...seeded.settings, env: { ORCH_TOKEN: 'ENV_VALUE_SENTINEL' } },
  } as unknown as typeof seeded)
  const html = render()
  expect(html).toContain('ORCH_TOKEN')
  expect(html).not.toContain('ENV_VALUE_SENTINEL')
})

test('managed hooks render fingerprints and never command text', () => {
  seedBase()
  const options = trpc.context.settings.get.queryOptions({ user: true })
  const seeded = queryClient.getQueryData(options.queryKey)!
  queryClient.setQueryData(options.queryKey, {
    ...seeded,
    settings: {
      ...seeded.settings,
      hooks: [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          fingerprint: '123456abcdef',
          command: 'HOOK_COMMAND_SENTINEL',
        },
      ],
    },
  } as unknown as typeof seeded)
  const html = render()
  expect(html).toContain('PreToolUse · Bash · 123456abcdef')
  expect(html).not.toContain('HOOK_COMMAND_SENTINEL')
})

test('managed settings shows the apply command without a write control', () => {
  seedBase()
  const html = render()
  expect(html).toContain('orch settings render --write --user --yes')
  expect(html).not.toContain('>Write settings<')
})

test('autonomy shows the resolved ship-to line and user-scope control', () => {
  seedBase()
  const html = render()
  expect(html).toContain('ship to: trunk (merge into main) (hosted user)')
  expect(html).toContain('ship to')
})

test('a machine override shows only on the row that has one', () => {
  seedBase()
  const absent = render()
  expect(absent).toContain('Override on this machine')
  expect(absent).not.toContain('review on this machine')

  const options = trpc.context.autonomy.get.queryOptions({ project: 'alpha' })
  const seeded = queryClient.getQueryData(options.queryKey)!
  if (!seeded.registered) throw new Error('expected a registered project')
  queryClient.setQueryData(options.queryKey, {
    ...seeded,
    stages: seeded.stages.map((stage) => ({ ...stage, machineValue: 'ask' as const })),
  } as typeof seeded)
  const present = render()
  expect(present).toContain('review on this machine')
  expect(present).not.toContain('release on this machine')
  expect(present).not.toContain('rulings on this machine')
})

test('user canon shows the signed-in refusal instead of an empty state', () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <UserCanonSection
        rows={undefined}
        pending={false}
        error="no signed-in record session; cleared by: run orch record login"
      />
    </QueryClientProvider>,
  )
  expect(html).toContain('no signed-in record session')
  expect(html).toContain('cleared by: run orch record login')
  expect(html).not.toContain('No rows')
})
