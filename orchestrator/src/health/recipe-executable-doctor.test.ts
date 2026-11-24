import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { DoctorReporter } from './doctor-reporter.ts'
import { recipeExecutableDoctorLines, reportProjectLifecycles } from './recipe-executable-doctor.ts'

test('reports missing tools from every tracked recipe phase', () => {
  expect(
    recipeExecutableDoctorLines(
      PLATFORM_SLUG,
      {
        create: [{ name: 'root-deps', run: { command: 'bun', args: [] } }],
        refresh: [{ name: 'refresh-root-deps', run: { command: 'bun', args: [] } }],
      },
      () => false,
    ),
  ).toEqual([
    `recipe tool    MISSING — project ${PLATFORM_SLUG} worktree recipe step root-deps (create) needs bun, which is not on PATH; install bun, then retry`,
    `recipe tool    MISSING — project ${PLATFORM_SLUG} worktree recipe step refresh-root-deps (refresh) needs bun, which is not on PATH; install bun, then retry`,
  ])
})

describe('project lifecycle recipe executable diagnosis', () => {
  let projectPath = ''

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'recipe-executable-doctor-'))
    writeFileSync(
      join(projectPath, 'worktree.jsonc'),
      JSON.stringify({
        worktree: { create: [{ name: 'root-deps', run: { command: 'missing-tool', args: [] } }] },
      }),
    )
  })

  afterEach(() => rmSync(projectPath, { recursive: true, force: true }))

  const reporter = () => {
    const lines: string[] = []
    const exitCodes: number[] = []
    const presentation: DoctorReporter = {
      log: (line) => lines.push(line),
      exitCode: (code) => exitCodes.push(code),
    }
    return { lines, exitCodes, presentation }
  }

  test('reports a missing tracked-recipe tool and exits nonzero', () => {
    const report = reporter()
    reportProjectLifecycles(
      [
        {
          name: PLATFORM_SLUG,
          path: projectPath,
          settings: { worktree: { recipePath: 'worktree.jsonc' } },
        },
      ],
      report.presentation,
      () => false,
    )

    expect(report.lines.filter((line) => line.includes('MISSING'))).toEqual([
      `recipe tool    MISSING — project ${PLATFORM_SLUG} worktree recipe step root-deps (create) needs missing-tool, which is not on PATH; install missing-tool, then retry`,
    ])
    expect(report.exitCodes).toEqual([1])
  })

  test('leaves the exit code alone when every tracked-recipe tool is present', () => {
    const report = reporter()
    reportProjectLifecycles(
      [
        {
          name: PLATFORM_SLUG,
          path: projectPath,
          settings: { worktree: { recipePath: 'worktree.jsonc' } },
        },
      ],
      report.presentation,
      () => true,
    )

    expect(report.lines.filter((line) => line.includes('MISSING'))).toEqual([])
    expect(report.exitCodes).toEqual([])
  })

  test('skips projects whose lifecycle is not a tracked recipe', () => {
    const report = reporter()
    reportProjectLifecycles(
      [
        {
          name: PLATFORM_SLUG,
          path: projectPath,
          settings: { worktree: { create: 'worktree-add' } },
        },
      ],
      report.presentation,
      () => false,
    )

    expect(report.lines.filter((line) => line.includes('MISSING'))).toEqual([])
    expect(report.exitCodes).toEqual([])
  })
})
