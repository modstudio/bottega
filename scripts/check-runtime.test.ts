import { describe, expect, test } from 'bun:test'
import {
  attributeCommandCpu,
  cpuBudgetMs,
  decideRuntimeBudget,
  dependencyInstallDecision,
  dependencyProvisioningBase,
  HUNG_SUITE_TIMEOUT_MS,
  parseCheckArguments,
  runsRootSuiteTests,
  SUITE_CPU_BUDGET_MS,
  SUITE_RUNTIME_BUDGET_MS,
  selectedCheckLegs,
} from './check-runtime'

describe('dependency installation', () => {
  test('a borrowed reader uses its HEAD as the provisioning base', () => {
    expect(dependencyProvisioningBase(true, false)).toBe('head')
  })

  test('a linked writer uses the registered landing branch merge base', () => {
    expect(dependencyProvisioningBase(false, true)).toBe('registered-landing-merge-base')
  })

  test('a linked writer refuses an unreadable registered landing branch', () => {
    expect(dependencyProvisioningBase(false, false)).toBe('unresolved')
  })

  test("a worker keeps using its base when main's lockfile advances", () => {
    const factsAfterMainAdvances = {
      workerRun: true,
      nodeModulesPresent: true,
      lockfileReadable: true,
      provisioningSourceResolved: true,
      lockfileMatchesProvisioningSource: true,
    }
    expect(dependencyInstallDecision(factsAfterMainAdvances)).toBe('skip-provisioned')
  })

  test('a worker refuses a lockfile change', () => {
    expect(
      dependencyInstallDecision({
        workerRun: true,
        nodeModulesPresent: true,
        lockfileReadable: true,
        provisioningSourceResolved: true,
        lockfileMatchesProvisioningSource: false,
      }),
    ).toBe('refuse-lockfile-change')
  })

  test('a worker refuses when node_modules is missing', () => {
    expect(
      dependencyInstallDecision({
        workerRun: true,
        nodeModulesPresent: false,
        lockfileReadable: true,
        provisioningSourceResolved: true,
        lockfileMatchesProvisioningSource: true,
      }),
    ).toBe('refuse-missing-node-modules')
  })

  test('a worker refuses when its bun.lock is unreadable', () => {
    expect(
      dependencyInstallDecision({
        workerRun: true,
        nodeModulesPresent: true,
        lockfileReadable: false,
        provisioningSourceResolved: true,
        lockfileMatchesProvisioningSource: false,
      }),
    ).toBe('refuse-unreadable-lockfile')
  })

  test('a worker refuses when its provisioning source cannot be resolved', () => {
    expect(
      dependencyInstallDecision({
        workerRun: true,
        nodeModulesPresent: true,
        lockfileReadable: true,
        provisioningSourceResolved: false,
        lockfileMatchesProvisioningSource: false,
      }),
    ).toBe('refuse-unresolved-provisioning-source')
  })

  test('a non-worker uses the normal install', () => {
    expect(
      dependencyInstallDecision({
        workerRun: false,
        nodeModulesPresent: false,
        lockfileReadable: false,
        provisioningSourceResolved: false,
        lockfileMatchesProvisioningSource: false,
      }),
    ).toBe('normal-install')
  })
})

describe('check mode arguments', () => {
  test('defaults to every static leg without a shard', () => {
    const parsed = parseCheckArguments([])
    expect(parsed).toEqual({ mode: 'static', omit: [] })
    expect(selectedCheckLegs(parsed)).toEqual([
      'cli',
      'orchestrator',
      'orchestrator/hooks',
      'hub',
      'hub/data',
      'hub/web',
      'hub/deploy/site',
      'retrieval',
      'shared',
    ])
  })

  test('selects one suite leg and preserves a valid shard', () => {
    const parsed = parseCheckArguments(['--suite', '--only=orchestrator', '--shard=2/4'])
    expect(parsed).toEqual({
      mode: 'suite',
      only: 'orchestrator',
      shard: { index: 2, total: 4, value: '2/4' },
      omit: [],
    })
    expect(selectedCheckLegs(parsed)).toEqual(['orchestrator'])
    expect(runsRootSuiteTests(parsed)).toBe(false)
    expect(runsRootSuiteTests(parseCheckArguments(['--suite', '--only=root']))).toBe(true)
  })

  test('refuses arguments that could silently omit a leg or use a malformed shard', () => {
    expect(() => parseCheckArguments(['--only=hub'])).toThrow('require --suite')
    expect(() => parseCheckArguments(['--suite', '--only=unknown'])).toThrow('expected one of')
    expect(() => parseCheckArguments(['--suite', '--shard=0/4'])).toThrow('1 <= M <= N')
    expect(() => parseCheckArguments(['--suite', '--shard=3/2'])).toThrow('1 <= M <= N')
    expect(() => parseCheckArguments(['--suite', '--only=hub', '--shard=1/4'])).toThrow(
      'only to the orchestrator',
    )
    expect(() => parseCheckArguments(['--suite', '--unexpected'])).toThrow('unknown')
  })

  test('accepts explicit static omit groups and refuses them in suite mode', () => {
    expect(parseCheckArguments(['--omit=machine-only', '--omit=secrets'])).toEqual({
      mode: 'static',
      omit: ['machine-only', 'secrets'],
    })
    expect(() => parseCheckArguments(['--suite', '--omit=machine-only'])).toThrow(
      'only to the static check',
    )
  })
})

describe('command CPU attribution', () => {
  test('orders commands by total CPU and calculates their share', () => {
    expect(
      attributeCommandCpu([
        { name: 'middle', userMs: 20, systemMs: 10 },
        { name: 'largest', userMs: 45, systemMs: 15 },
        { name: 'smallest', userMs: 5, systemMs: 5 },
      ]),
    ).toEqual({
      totalMs: 100,
      commands: [
        { name: 'largest', cpuMs: 60, share: 0.6 },
        { name: 'middle', cpuMs: 30, share: 0.3 },
        { name: 'smallest', cpuMs: 10, share: 0.1 },
      ],
    })
  })
})

describe('suite runtime budget', () => {
  test('the slowest measured CI shard (214 s on an unchanged test set) stays within the suite CPU budget', () => {
    expect(
      decideRuntimeBudget({
        elapsedMs: 214_000,
        budgetMs: cpuBudgetMs('suite'),
        ci: true,
        measure: 'cpu',
      }),
    ).toBe('within')
  })

  test('CPU time over the suite budget under CI is fatal', () => {
    expect(
      decideRuntimeBudget({
        elapsedMs: SUITE_CPU_BUDGET_MS + 1,
        budgetMs: SUITE_CPU_BUDGET_MS,
        ci: true,
        measure: 'cpu',
      }),
    ).toBe('over-fatal')
  })

  test('wall clock over budget under CI is informational', () => {
    expect(
      decideRuntimeBudget({
        elapsedMs: SUITE_RUNTIME_BUDGET_MS + 1,
        budgetMs: SUITE_RUNTIME_BUDGET_MS,
        ci: true,
        measure: 'wall',
      }),
    ).toBe('over-informational')
  })

  test('hung-suite timeout remains separate from the regression budget', () => {
    expect(HUNG_SUITE_TIMEOUT_MS).toBeGreaterThan(SUITE_RUNTIME_BUDGET_MS)
  })
})
