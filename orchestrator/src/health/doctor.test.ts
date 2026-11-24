import { afterEach, describe, expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import {
  type FocusedTestDeclaration,
  validateFocusedTestDeclaration,
} from '../focused-test/focused-test-decision.ts'
import { mainCheckoutInvariant } from '../project/main-checkout-invariant.ts'
import { mergeProjectSettings, parseSettingsPatch } from '../project/project-settings-patch.ts'
import { acpRuntimeGaps } from '../transport/transport.ts'
import {
  activeSpaceDoctorDiagnosis,
  affectedSelectorDoctorFinding,
  canonEvalDoctorDecision,
  doctorAcpStatus,
  doctorRegisterBranchProblems,
  registeredMainCheckoutDiagnosis,
  recipeExecutableDoctorLines,
  reportActiveSpaceDoctor,
  reportCheckoutRegister,
  sandboxRuntimeDoctorLine,
  workerCheckDoctorFinding,
} from './doctor.ts'

test('machine doctor reports missing tools from every tracked recipe phase', () => {
  expect(
    recipeExecutableDoctorLines(
      'bottega',
      {
        create: [{ name: 'root-deps', run: { command: 'bun', args: [] } }],
        refresh: [{ name: 'refresh-root-deps', run: { command: 'bun', args: [] } }],
      },
      () => false,
    ),
  ).toEqual([
    'recipe tool    MISSING — project bottega worktree recipe step root-deps (create) needs bun, which is not on PATH; install bun, then retry',
    'recipe tool    MISSING — project bottega worktree recipe step refresh-root-deps (refresh) needs bun, which is not on PATH; install bun, then retry',
  ])
})

test('sandbox doctor prints each readiness fix on its own indented line', () => {
  expect(
    sandboxRuntimeDoctorLine({
      available: false,
      location: '/runtime',
      missingSystemDependencies: [],
      condition: 'the namespace probe failed',
      remedy: 'the namespace probe failed; first; second',
      fixes: ['first', 'second'],
      sandboxProbeUnavailableReason: null,
    }),
  ).toBe(
    'sandbox        runtime NOT AVAILABLE at /runtime; the namespace probe failed\n  first\n  second',
  )
})

test('sandbox doctor reports an unknown namespace probe without blocking availability', () => {
  expect(
    sandboxRuntimeDoctorLine({
      available: true,
      location: '/runtime',
      missingSystemDependencies: [],
      condition: 'the sandbox runtime is not installed completely',
      remedy: 'the sandbox runtime is not installed completely; ',
      fixes: [],
      sandboxProbeUnavailableReason: 'wrapper import failed',
    }),
  ).toBe(
    `sandbox        runtime available at /runtime\nsandbox probe unavailable: wrapper import failed; ${PLATFORM_NAME} cannot confirm the sandbox works on this host`,
  )
})

test('machine doctor reports whoami active-space results without claiming unavailable checks pass', async () => {
  const passing = await activeSpaceDoctorDiagnosis(async () => ({
    user: { id: 'user-a' },
    activeSpaceId: 'space-a',
    personalSpaceId: null,
    memberships: [
      {
        space_id: 'space-a',
        name: 'Alpha',
        slug: 'alpha',
        role: 'owner',
        permission: 'write',
      },
    ],
  }))
  expect(passing).toEqual({ line: 'active space   pass — alpha', failed: false })

  const failing = await activeSpaceDoctorDiagnosis(async () => ({
    user: { id: 'user-a' },
    activeSpaceId: 'space-stale',
    personalSpaceId: null,
    memberships: [
      {
        space_id: 'space-a',
        name: 'Alpha',
        slug: 'alpha',
        role: 'owner',
        permission: 'write',
      },
    ],
  }))
  expect(failing.failed).toBe(true)
  expect(failing.line).toContain('FAIL')
  const output: string[] = []
  const exitCodes: number[] = []
  await reportActiveSpaceDoctor(
    {
      log: (line) => output.push(line),
      exitCode: (code) => exitCodes.push(code),
    },
    async () => failing,
  )
  expect(output).toHaveLength(1)
  expect(output[0]).toContain('FAIL')
  expect(exitCodes).toEqual([1])

  const signedOut = await activeSpaceDoctorDiagnosis(async () => {
    throw new Error(RECORD_SIGN_IN_REMEDY)
  })
  expect(signedOut).toEqual({
    line: `active space   check could not run — no one is signed in; ${RECORD_SIGN_IN_REMEDY}`,
    failed: false,
  })

  const unavailable = await activeSpaceDoctorDiagnosis(async () => {
    throw new Error('record unavailable')
  })
  expect(unavailable).toEqual({
    line: 'active space   check could not run — record unavailable',
    failed: false,
  })
})

test('machine doctor fails only tracked-dirty projects that require a clean main', () => {
  expect(
    registeredMainCheckoutDiagnosis({
      name: 'strict',
      requireCleanMain: true,
      checkout: { branch: 'main', trunk: 'main', trackedModified: true },
      decide: (facts) => mainCheckoutInvariant('/strict', facts),
    }),
  ).toMatchObject({ failed: true, lines: [expect.stringContaining('FAIL')] })

  expect(
    registeredMainCheckoutDiagnosis({
      name: 'permissive',
      requireCleanMain: false,
      checkout: { branch: 'main', trunk: 'main', trackedModified: true },
      decide: (facts) => mainCheckoutInvariant('/permissive', facts),
    }),
  ).toEqual({
    failed: false,
    lines: ['permissive info — tracked modifications are allowed by requireCleanMain false'],
  })
})

test('machine doctor keeps a wrong branch as a register question', () => {
  const diagnosis = registeredMainCheckoutDiagnosis({
    name: 'branchy',
    requireCleanMain: true,
    checkout: { branch: 'feature', trunk: 'main', trackedModified: false },
    decide: (facts) => mainCheckoutInvariant('/branchy', facts),
  })
  expect(diagnosis.failed).toBe(false)
  expect(diagnosis.lines).toEqual([expect.stringContaining('register question')])
  expect(diagnosis.lines[0]).toContain("run git -C '/branchy' switch 'main'")
  expect(diagnosis.lines[0]).not.toContain('FAIL')
})

test('machine doctor carries on after one checkout git inspection fails', () => {
  const output: string[] = []
  const exitCodes: number[] = []
  const projects = [
    { name: 'broken', path: '/broken', settings: {} },
    { name: 'clean', path: '/clean', settings: {} },
  ]
  reportCheckoutRegister(
    projects,
    { log: (line) => output.push(line), exitCode: (code) => exitCodes.push(code) },
    () => null,
    () => ({ landing: 'main', problems: [] }),
    (path, trunk) => {
      if (path === '/broken') throw new Error('git refused this checkout')
      return { branch: 'main', trunk, trackedModified: false }
    },
    mainCheckoutInvariant,
  )

  expect(exitCodes).toEqual([])
  expect(output).toContain('  broken check could not run — git refused this checkout')
  expect(output).toContain('  clean pass — branch main, tracked clean')
})

test('machine doctor asks to declare a missing repository landing branch', () => {
  const output: string[] = []
  const exitCodes: number[] = []
  reportCheckoutRegister(
    [{ name: 'probe', path: process.cwd(), settings: {} }],
    { log: (line) => output.push(line), exitCode: (code) => exitCodes.push(code) },
    () => null,
    doctorRegisterBranchProblems,
    () => {
      throw new Error('a checkout without a landing branch must not be inspected')
    },
    mainCheckoutInvariant,
  )

  expect(output).toContain('\nregister questions (not run failures):')
  expect(output).toContain(
    `  probe: probe has no landing branch\ncleared by: ${PLATFORM_SLUG} project set probe --settings '{"trunk":"<branch>"}'`,
  )
  expect(exitCodes).toEqual([])
})

afterEach(() => registerEmbeddedAssets(null))

describe('doctor canon eval presentation', () => {
  test('marks only an established result against the current platform canon as current', () => {
    expect(
      canonEvalDoctorDecision({
        pass: true,
        recordedSha: 'current-sha',
        currentSha: 'current-sha',
        currentCanonError: null,
      }),
    ).toEqual({ result: 'pass (current canon)', unavailableReason: null })
  })

  test('keeps reporting rows and names why the platform canon could not be computed', () => {
    expect(
      canonEvalDoctorDecision({
        pass: true,
        recordedSha: 'recorded-sha',
        currentSha: null,
        currentCanonError: 'project has no canon',
      }),
    ).toEqual({ result: 'pass', unavailableReason: 'project has no canon' })
    expect(
      canonEvalDoctorDecision({
        pass: false,
        recordedSha: 'recorded-sha',
        currentSha: null,
        currentCanonError: 'project has no canon',
      }),
    ).toEqual({ result: 'FAIL', unavailableReason: 'project has no canon' })
  })
})

test('a missing optional ACP runtime is informational', () => {
  expect(doctorAcpStatus('codex-acp is not installed')).toBe(
    'informational — codex-acp is not installed',
  )
  expect(doctorAcpStatus(null)).toBe('ready')
})

test('a compiled install reports missing codex-acp as informational', () => {
  registerEmbeddedAssets({
    assets: {},
    files: {},
    manifest: {
      name: PLATFORM_NAME,
      version: '1.2.3',
      built: '2026-10-05T00:00:00.000Z',
      commit: 'abcdef1234567890',
    },
  })
  const gap = acpRuntimeGaps({
    env: {},
    which: () => null,
    sdkResolve: () => '/fake/sdk',
    ajvResolve: () => '/fake/ajv',
  })
  expect(gap).toContain('codex-acp executable is not installed')
  expect(doctorAcpStatus(gap)).toStartWith('informational — ')
})

describe('project worker check diagnosis', () => {
  test('reports a differing registered command with the exact repair', () => {
    expect(
      workerCheckDoctorFinding({
        project: 'fixture',
        workerCheck: 'bun run old-worker-check',
        scripts: { 'check:worker': 'bun scripts/check.ts --worker' },
      }),
    ).toBe(
      `fixture: registered workerCheck "bun run old-worker-check" differs from package script "bun run check:worker"; set it with: ${PLATFORM_SLUG} project set fixture --settings '{"workerCheck":"bun run check:worker"}'`,
    )
  })

  test('reports nothing for the matching command or a project without the script', () => {
    expect(
      workerCheckDoctorFinding({
        project: 'fixture',
        workerCheck: 'bun run check:worker',
        scripts: { 'check:worker': 'bun scripts/check.ts --worker' },
      }),
    ).toBeNull()
    expect(
      workerCheckDoctorFinding({
        project: 'fixture',
        workerCheck: 'bun run old-worker-check',
        scripts: { check: 'bun scripts/check.ts' },
      }),
    ).toBeNull()
  })
})

describe('project affected-test selector diagnosis', () => {
  test('reports nothing without the package script marker', () => {
    expect(
      affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests: undefined,
        scripts: { test: 'bun test' },
      }),
    ).toBeNull()
  })

  test('reports an unset selector with the exact repair', () => {
    expect(
      affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests: { command: 'bun', args: ['test'] },
        scripts: { 'test:affected': 'scripts/affected-tests.ts' },
      }),
    ).toBe(
      `fixture: registered focusedTests.affected (unset) differs from package script "bun run test:affected"; set it with: ${PLATFORM_SLUG} project set fixture --settings '{"focusedTests":{"affected":{"command":"bun","args":["run","test:affected"]}}}'`,
    )
  })

  test('reports a registered runner without a selector when there is no marker script', () => {
    const finding = affectedSelectorDoctorFinding({
      project: 'stopal',
      focusedTests: { command: 'node_modules/.bin/vitest', args: ['run'] },
      scripts: { test: 'vitest run' },
    })

    expect(finding).not.toBeNull()
    expect(finding).toContain('stopal')
    expect(finding).toContain('node_modules/.bin/vitest')
    expect(finding).toContain(`${PLATFORM_SLUG} project set stopal --settings`)
  })

  test('prints accepted no-marker repairs for flat and runners declarations', () => {
    const declarations: FocusedTestDeclaration[] = [
      { command: 'node_modules/.bin/vitest', args: ['run'] },
      {
        runners: [
          {
            command: 'bun',
            args: ['test'],
            patterns: ['src/**/*.test.ts'],
          },
          {
            command: 'bun',
            args: ['test', 'integration'],
            patterns: ['integration/**/*.test.ts'],
            affected: { command: 'scripts/integration-affected.ts', args: ['--paths'] },
          },
        ],
      },
    ]
    for (const focusedTests of declarations) {
      const finding = affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests,
        scripts: {},
      })
      const patch = finding?.match(/--settings '(.*)'$/)?.[1]
      expect(patch).toBeDefined()
      const repaired = mergeProjectSettings(
        { focusedTests },
        parseSettingsPatch(String(patch).replaceAll('<selector command>', 'scripts/affected.ts')),
      ).focusedTests as FocusedTestDeclaration
      expect(validateFocusedTestDeclaration(repaired).problems).toEqual([])
      expect(
        affectedSelectorDoctorFinding({ project: 'fixture', focusedTests: repaired, scripts: {} }),
      ).toBeNull()
      if ('runners' in repaired) {
        expect(repaired.runners[0]?.patterns).toEqual(['src/**/*.test.ts'])
        expect(repaired.runners[1]).toEqual({
          command: 'bun',
          args: ['test', 'integration'],
          patterns: ['integration/**/*.test.ts'],
          affected: { command: 'scripts/integration-affected.ts', args: ['--paths'] },
        })
      }
    }
  })

  test('prints an accepted runners repair when the marker script is present', () => {
    const scripts = { 'test:affected': 'scripts/affected-tests.ts' }
    const focusedTests: FocusedTestDeclaration = {
      runners: [
        {
          command: 'bun',
          args: ['test'],
          patterns: ['src/**/*.test.ts'],
        },
      ],
    }
    const finding = affectedSelectorDoctorFinding({ project: 'fixture', focusedTests, scripts })
    expect(finding).not.toBeNull()
    const patch = finding?.match(/--settings '(.*)'$/)?.[1]
    expect(patch).toBeDefined()
    const repaired = mergeProjectSettings(
      { focusedTests },
      parseSettingsPatch(String(patch).replaceAll('<selector command>', 'scripts/affected.ts')),
    ).focusedTests as FocusedTestDeclaration
    expect(validateFocusedTestDeclaration(repaired).problems).toEqual([])
    expect(repaired).toEqual({
      runners: [
        {
          command: 'bun',
          args: ['test'],
          patterns: ['src/**/*.test.ts'],
          affected: { command: 'scripts/affected.ts', args: [] },
        },
      ],
    })
    expect(
      affectedSelectorDoctorFinding({ project: 'fixture', focusedTests: repaired, scripts }),
    ).toBeNull()
  })

  test('reports nothing for runners with selectors when the marker script is present', () => {
    expect(
      affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests: {
          runners: [
            {
              command: 'bun',
              args: ['test'],
              affected: { command: 'scripts/affected.ts', args: [] },
            },
          ],
        },
        scripts: { 'test:affected': 'scripts/affected-tests.ts' },
      }),
    ).toBeNull()
  })

  test('reports a different registered selector', () => {
    expect(
      affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests: {
          command: 'bun',
          args: ['test'],
          affected: { command: 'scripts/old-affected-tests.ts', args: [] },
        },
        scripts: { 'test:affected': 'scripts/affected-tests.ts' },
      }),
    ).toContain(
      'registered focusedTests.affected {"command":"scripts/old-affected-tests.ts","args":[]}',
    )
  })

  test('prints a repair the register accepts and that clears the finding', () => {
    const scripts = { 'test:affected': 'scripts/affected-tests.ts' }
    const declarations: (FocusedTestDeclaration | undefined)[] = [
      undefined,
      { command: 'bun', args: ['test'] },
      {
        command: 'bun',
        args: ['test'],
        affected: { command: 'scripts/old-affected-tests.ts', args: [] },
      },
    ]
    for (const focusedTests of declarations) {
      const finding = affectedSelectorDoctorFinding({ project: 'fixture', focusedTests, scripts })
      const patch = finding?.match(/--settings '(.*)'$/)?.[1]
      expect(patch).toBeDefined()
      const repaired = mergeProjectSettings(
        focusedTests ? { focusedTests } : {},
        parseSettingsPatch(String(patch).replace('<runner command>', 'bun')),
      ).focusedTests as FocusedTestDeclaration
      expect(validateFocusedTestDeclaration(repaired).problems).toEqual([])
      expect(
        affectedSelectorDoctorFinding({ project: 'fixture', focusedTests: repaired, scripts }),
      ).toBeNull()
    }
  })

  test('reports nothing for the canonical selector', () => {
    expect(
      affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests: {
          command: 'bun',
          args: ['test'],
          affected: { command: 'bun', args: ['run', 'test:affected'] },
        },
        scripts: { 'test:affected': 'scripts/affected-tests.ts' },
      }),
    ).toBeNull()
  })

  test('reports nothing for a declared selector without a marker script', () => {
    expect(
      affectedSelectorDoctorFinding({
        project: 'fixture',
        focusedTests: {
          command: 'bun',
          args: ['test'],
          affected: { command: 'scripts/affected-tests.ts', args: [] },
        },
        scripts: { test: 'bun test' },
      }),
    ).toBeNull()
  })
})
