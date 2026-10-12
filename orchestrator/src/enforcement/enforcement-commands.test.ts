import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from '../project/projects.ts'
import { enforcementCommand } from './enforcement-commands.ts'

const project = (name: string): Project => ({
  id: 1,
  name,
  path: `/work/${name}`,
  stack: 'node',
  canon: true,
  retiredAt: null,
  settings: {
    release: {
      rungs: [],
      mergeMethod: 'squash',
      requiredChecks: ['remote-gate'],
    },
  },
})

function capture() {
  const output: string[] = []
  const errors: string[] = []
  let exitCode = 0
  return {
    output,
    errors,
    exitCode: () => exitCode,
    presentation: {
      log: (value: string) => output.push(value),
      error: (value: string) => errors.push(value),
      setExitCode: (value: number) => {
        exitCode = value
      },
      cwd: () => '/work/fixture',
    },
  }
}

describe('enforcementCommand', () => {
  test('prints the stable JSON envelope and remote required checks', () => {
    const result = capture()
    enforcementCommand({ project: 'fixture', json: true }, result.presentation, {
      projects: () => [project('fixture')],
      projectByName: (name) => (name === 'fixture' ? project(name) : null),
      projectAt: () => null,
    })
    const payload = JSON.parse(result.output.join('\n'))
    expect(payload.projects[0]).toMatchObject({
      project: 'fixture',
      remoteRequiredChecks: ['remote-gate'],
    })
    expect(payload.projects[0].rows[0].category).toBe('naming')
    expect(result.exitCode()).toBe(0)
  })

  test('prints a JSON error and exits nonzero for an unregistered named project', () => {
    const result = capture()
    enforcementCommand({ project: 'missing', json: true }, result.presentation, {
      projects: () => [],
      projectByName: () => null,
      projectAt: () => null,
    })
    expect(JSON.parse(result.output.join('\n'))).toEqual({
      error: 'project "missing" is not registered',
    })
    expect(result.exitCode()).toBe(1)
  })

  test('distinguishes enforced, standard, and uncovered rows in text and summarizes them', () => {
    const result = capture()
    enforcementCommand({ project: 'fixture' }, result.presentation, {
      projects: () => [project('fixture')],
      projectByName: (name) => (name === 'fixture' ? project(name) : null),
      projectAt: () => null,
    })

    const heading = result.output.find((line) => line.startsWith('category'))
    const functionLength = result.output.find((line) => line.startsWith('function-length'))
    const testSubstance = result.output.find((line) => line.startsWith('test-substance'))
    const filePlacement = result.output.find((line) => line.startsWith('file-placement'))
    expect(heading?.split(/\s{2,}/).slice(0, 2)).toEqual(['category', 'enforced'])
    expect(functionLength?.split(/\s{2,}/).slice(0, 3)).toEqual([
      'function-length',
      'no',
      'Function length',
    ])
    expect(functionLength).toContain('[biome complexity/noExcessiveLinesPerFunction]')
    expect(functionLength).toContain('[write, commit]')
    expect(functionLength).toContain('[yes]')
    expect(functionLength).toContain('[50]')
    expect(testSubstance?.split(/\s{2,}/).slice(0, 3)).toEqual([
      'test-substance',
      'yes',
      'Tests that assert nothing',
    ])
    expect(testSubstance).toContain(`${PLATFORM_SLUG} test-substance`)
    expect(testSubstance).not.toContain(`[${PLATFORM_SLUG} test-substance]`)
    expect(filePlacement?.split(/\s{2,}/).slice(4, 8)).toEqual(['—', '—', '—', '—'])
    expect(result.output).toContain(
      'summary: 2 enforced, 14 standard defaults not adopted, 8 uncovered, 0 opt-outs',
    )
    expect(result.exitCode()).toBe(0)
  })
})
