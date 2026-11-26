import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CHECKOUT_CLI_BINARY_ENV } from '../../../shared/install-root.ts'
import {
  handoffPostUpdateSteps,
  postUpdateSteps,
  runLaunchAgentsRefreshVerb,
  runPostUpdateSteps,
} from './post-update-steps.ts'

const checkout = resolve(import.meta.dir, '../../..')
const checkoutBinary = `/checkout/bin/${PLATFORM_SLUG}`
const distributionBinary = `/opt/${PLATFORM_SLUG}`

test('post-update paths have one exact ordered step list', () => {
  expect(postUpdateSteps('checkout')).toEqual([
    'verify-main-checkout',
    'workflow-sync',
    'build-checkout-cli',
    'store-maintenance',
    'launch-agent-refresh',
    'verify-main-checkout',
    'hosted-row-release',
    'default-project-retirement',
  ])
  expect(postUpdateSteps('distribution')).toEqual([
    'store-maintenance',
    'launch-agent-refresh',
    'hosted-row-release',
    'default-project-retirement',
  ])
})

test('post-update handoff failures name the exact checkout and distribution rerun commands', () => {
  const presentation = { log: () => {} }
  const spawn = () => ({ exitCode: 7 })
  expect(() =>
    handoffPostUpdateSteps({
      binary: checkoutBinary,
      path: {
        path: 'checkout',
        checkout: '/checkout',
        branch: 'main',
        beforePull: 'abc123',
      },
      presentation,
      spawn,
    }),
  ).toThrow(
    `post-update steps failed with exit 7; run ${checkoutBinary} machine post-update checkout /checkout main abc123`,
  )
  expect(() =>
    handoffPostUpdateSteps({
      binary: distributionBinary,
      path: { path: 'distribution' },
      presentation,
      spawn,
    }),
  ).toThrow(
    `post-update steps failed with exit 7; run ${distributionBinary} machine post-update distribution`,
  )
})

test('post-update handoff strips checkout CLI selection and marks the update lock held', () => {
  let environment: Record<string, string | undefined> = {}
  handoffPostUpdateSteps({
    binary: checkoutBinary,
    path: {
      path: 'checkout',
      checkout: '/checkout',
      branch: 'main',
      beforePull: 'abc123',
    },
    presentation: { log: () => {} },
    environment: { [CHECKOUT_CLI_BINARY_ENV]: '/outgoing/compiled-cli' },
    spawn: (_argv, options) => {
      environment = options.env
      return { exitCode: 0 }
    },
  })
  expect(environment[CHECKOUT_CLI_BINARY_ENV]).toBeUndefined()
  expect(environment[`${PLATFORM_SLUG.toUpperCase()}_MACHINE_UPDATE_LOCK_HELD`]).toBe('1')
})

test('checkout post-update adapter runs every step in decision order', async () => {
  const events: string[] = []
  await runPostUpdateSteps(
    { log: (line) => events.push(`log:${line}`) },
    { path: 'checkout', checkout, branch: 'main', beforePull: 'abc123' },
    {
      verifyMainCheckout: () => events.push('verify'),
      syncWorkflows: (_cwd, since) => events.push(`sync:${since}`),
      buildCli: () => events.push('build'),
      maintainStore: () => events.push('maintain'),
      runLaunchAgentsRefreshVerb: (binary, restart) => events.push(`refresh:${binary}:${restart}`),
      releaseHostedRows: async () => {
        events.push('release')
      },
      recordSessionPresent: () => true,
      retireUnusedDefaultLocalProject: async () => {
        events.push('retire')
        return false
      },
    },
  )
  expect(events).toEqual([
    'verify',
    'sync:abc123',
    'build',
    'maintain',
    `refresh:${checkout}/bin/${PLATFORM_SLUG}:false`,
    'verify',
    'release',
    'retire',
  ])
})

test('only distribution post-update requests long-running service restarts', async () => {
  const requests: boolean[] = []
  const dependencies = {
    verifyMainCheckout: () => {},
    syncWorkflows: () => {},
    buildCli: () => {},
    maintainStore: () => {},
    runLaunchAgentsRefreshVerb: (_binary: string, restart: boolean) => requests.push(restart),
    releaseHostedRows: async () => {},
    recordSessionPresent: () => false,
    storeAttachedToHostedRecord: () => false,
  }
  await runPostUpdateSteps(
    { log: () => {} },
    { path: 'checkout', checkout, branch: 'main', beforePull: 'abc123' },
    dependencies,
  )
  await runPostUpdateSteps({ log: () => {} }, { path: 'distribution' }, dependencies)
  expect(requests).toEqual([false, true])
})

test('launch-agent refresh argv includes the restart flag only when requested', () => {
  const calls: string[][] = []
  const spawn = ((argv: readonly string[]) => {
    calls.push([...argv])
    return { exitCode: 0, stdout: '', stderr: '' }
  }) as typeof import('../../../shared/bounded-process.ts').startBoundedSync

  runLaunchAgentsRefreshVerb(distributionBinary, false, spawn)
  runLaunchAgentsRefreshVerb(distributionBinary, true, spawn)

  expect(calls).toEqual([
    [distributionBinary, 'machine', 'launch-agents', 'refresh'],
    [distributionBinary, 'machine', 'launch-agents', 'refresh', '--restart-long-running'],
  ])
})

test('post-update store maintenance logs and continues', async () => {
  const lines: string[] = []
  const events: string[] = []
  await runPostUpdateSteps(
    { log: (line) => lines.push(line) },
    { path: 'distribution' },
    {
      maintainStore: () => {
        throw new Error('store busy')
      },
      runLaunchAgentsRefreshVerb: () => events.push('refresh'),
      releaseHostedRows: async () => {
        events.push('release')
      },
      recordSessionPresent: () => false,
      storeAttachedToHostedRecord: () => false,
    },
  )
  expect(lines).toEqual([
    `incremental vacuum setup skipped: store busy; retry with ${PLATFORM_SLUG} machine update`,
  ])
  expect(events).toEqual(['refresh', 'release'])
})

test('post-update checkout build keeps its machine-update remedy', async () => {
  await expect(
    runPostUpdateSteps(
      { log: () => {} },
      { path: 'checkout', checkout, branch: 'main', beforePull: 'abc123' },
      {
        verifyMainCheckout: () => {},
        syncWorkflows: () => {},
        buildCli: () => {
          throw new Error('compiler unavailable')
        },
      },
    ),
  ).rejects.toThrow(
    `compiled checkout CLI build failed: compiler unavailable; rerun ${PLATFORM_SLUG} machine update`,
  )
})

test('post-update launch-agent refresh preserves its failure', async () => {
  const remedy = `definition still drifted; run ${PLATFORM_SLUG} machine setup apply`
  await expect(
    runPostUpdateSteps(
      { log: () => {} },
      { path: 'distribution' },
      {
        maintainStore: () => {},
        runLaunchAgentsRefreshVerb: () => {
          throw new Error(remedy)
        },
      },
    ),
  ).rejects.toThrow(remedy)
})

test('post-update hosted-row release preserves its refusal and stops retirement', async () => {
  let retired = false
  await expect(
    runPostUpdateSteps(
      { log: () => {} },
      { path: 'distribution' },
      {
        maintainStore: () => {},
        runLaunchAgentsRefreshVerb: () => {},
        releaseHostedRows: async () => {
          throw new Error('release refusal')
        },
        recordSessionPresent: () => true,
        retireUnusedDefaultLocalProject: async () => {
          retired = true
          return true
        },
      },
    ),
  ).rejects.toThrow('release refusal')
  expect(retired).toBeFalse()
})

test('post-update checkout verification preserves the checkout invariant failure', async () => {
  await expect(
    runPostUpdateSteps(
      { log: () => {} },
      { path: 'checkout', checkout, branch: 'main', beforePull: 'abc123' },
      {
        git: (_cwd, args) => {
          if (args[0] === 'branch') return 'main'
          if (args[0] === 'status') return ' M tracked.ts'
          return ''
        },
      },
    ),
  ).rejects.toThrow('checkout has tracked modifications')
})
