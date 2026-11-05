import { beforeEach, expect, test } from 'bun:test'
import { queryClient, trpc } from '@bottega/hub-data/client'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UserCanonSection } from '@/routes/-personal-instructions'
import { PersonalPermissionsPage } from '@/routes/-personal-permissions'
import { autonomyLayers, PersonalAutonomyPage } from '@/routes/-personal-settings'

import { PLATFORM_SLUG } from '../../../../shared/brand.ts'

const doc = {
  record_id: '00000000-0000-4000-8000-000000000001',
  scope: 'canon' as const,
  subject: null,
  slug: 'preferences',
  title: 'Preferences',
  body: '# Prefer concise reports',
  delivery: 'inject' as const,
  audiences: ['technical'] as ['technical'],
  parent_record_id: null,
  parent_slug: null,
  position: 0,
  kind: 'working' as const,
  revision: 'revision-1',
  created_at: '2026-09-25T12:00:00.000Z',
  updated_at: '2026-09-25T12:00:00.000Z',
}

function render(page: () => ReactNode) {
  const Page = page
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Page />
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
    stages: [
      { stage: 'review', agreed: true as const, value: 'review', scope: 'hosted user', steps: 2 },
    ],
    text: 'Autonomy for alpha\nship to: trunk (merge into main) (hosted user)',
  }
  queryClient.setQueryData(autonomyOptions.queryKey, autonomy)
  queryClient.setQueryData(trpc.context.settings.get.queryOptions({ user: true }).queryKey, {
    target: { kind: 'user' },
    file: { path: '/home/operator/.claude/settings.json', exists: true },
    revision: 'revision-settings',
    settings: {
      permissions: { allow: [`Bash(${PLATFORM_SLUG} run result *)`], ask: [], deny: [] },
      hooks: [{ event: 'PreToolUse', matcher: 'Bash', fingerprint: '123456abcdef' }],
      envKeys: ['BOTTEGA_TOKEN'],
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
    settings: { ...seeded.settings, env: { BOTTEGA_TOKEN: 'ENV_VALUE_SENTINEL' } },
  } as unknown as typeof seeded)
  const html = render(PersonalPermissionsPage)
  expect(html).toContain('BOTTEGA_TOKEN')
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
  const html = render(PersonalPermissionsPage)
  expect(html).toContain('PreToolUse · Bash · 123456abcdef')
  expect(html).not.toContain('HOOK_COMMAND_SENTINEL')
})

test('managed settings shows the apply command without a write control', () => {
  seedBase()
  const html = render(PersonalPermissionsPage)
  expect(html).toContain(`${PLATFORM_SLUG} machine settings render --write --user --yes`)
  expect(html).not.toContain('>Write settings<')
})

const quiet = { plan: null, implement: null, review: null, docs: null, canon: null, ship: null }
const silent = (scope: string) => ({
  scope,
  preset: null,
  rulings: null,
  shipTo: null,
  stages: quiet,
})
const auto = {
  plan: 'auto',
  implement: 'auto',
  review: 'auto',
  docs: 'auto',
  canon: 'auto',
  ship: 'auto',
} as const

function resolution(hostedScope: string, userPreset: 'autonomous' | null | undefined) {
  return {
    registered: true as const,
    project: 'alpha',
    rulings: { value: 'agent' as const, scope: hostedScope },
    shipTo: { value: 'trunk' as const, scope: hostedScope, landing: 'main', production: null },
    stages: [
      {
        stage: 'plan' as const,
        agreed: true as const,
        value: 'auto' as const,
        scope: hostedScope,
        steps: 1,
        overridden: false,
      },
      {
        stage: 'canon' as const,
        agreed: true as const,
        value: 'ask' as const,
        scope: 'local user',
        steps: 1,
        overridden: true,
      },
    ],
    text: '',
    userPreset,
    layers: [
      silent('session'),
      silent('project'),
      { ...silent('local user'), stages: { ...quiet, canon: 'ask' as const } },
      {
        scope: hostedScope,
        preset: 'autonomous' as const,
        rulings: 'agent' as const,
        shipTo: 'trunk' as const,
        stages: { ...auto, canon: 'review' as const },
      },
      silent('built-in'),
    ],
  }
}

test('autonomy rows keep the resolver order and edit only this machine and your account', () => {
  const layers = autonomyLayers(resolution('hosted user', 'autonomous'))
  expect(layers.map((layer) => layer.label)).toEqual([
    'Project settings',
    'This machine',
    'Your account',
    'Built-in',
  ])
  const [project, machine, account] = layers
  expect(project!.editable).toBeUndefined()
  expect(machine!.editable?.canon?.selected).toBe('ask')
  expect(machine!.editable?.plan?.selected).toBeNull()
  // A stage that follows the preset has a value but no choice of its own.
  expect(account!.values.plan).toBe('auto')
  expect(account!.editable?.plan).toMatchObject({
    selected: null,
    unset: { label: 'Preset (auto)' },
  })
  expect(account!.editable?.canon?.selected).toBe('review')
  expect(account!.editable?.rulings).toBeUndefined()
})

test('a stale or signed-out account row reads only', () => {
  const stale = autonomyLayers(resolution('hosted user (stale)', 'autonomous'))
  const staleAccount = stale.find((layer) => layer.scope === 'hosted user (stale)')!
  expect(staleAccount.label).toBe('Your account')
  expect(staleAccount.hint).toContain('Read from the cache')
  expect(staleAccount.editable).toBeUndefined()
  const signedOut = autonomyLayers(resolution('hosted user', undefined))
  expect(signedOut.find((layer) => layer.scope === 'hosted user')!.editable).toBeUndefined()
})

test('the autonomy page marks what is in effect and where it came from', () => {
  seedBase()
  queryClient.setQueryData(
    trpc.context.autonomy.get.queryOptions({ project: 'alpha' }).queryKey,
    resolution('hosted user', 'autonomous'),
  )
  const html = render(PersonalAutonomyPage)
  expect(html).toContain('In effect')
  expect(html).toContain('Where each setting comes from')
  expect(html).not.toContain('This session')
})

test('user canon shows the signed-in refusal instead of an empty state', () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <UserCanonSection
        rows={undefined}
        pending={false}
        error={`no signed-in record session; cleared by: run ${PLATFORM_SLUG} record login`}
      />
    </QueryClientProvider>,
  )
  expect(html).toContain('no signed-in record session')
  expect(html).toContain(`cleared by: run ${PLATFORM_SLUG} record login`)
  expect(html).not.toContain('No rows')
})
