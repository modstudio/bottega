import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orchestratorProseGate } from './prose-service.ts'

describe('orchestratorProseGate machine configuration', () => {
  let previousConfigHome: string | undefined
  let configHome = ''

  beforeEach(() => {
    previousConfigHome = process.env.BOTTEGA_CONFIG_HOME
    configHome = mkdtempSync(join(tmpdir(), 'prose-service-'))
    process.env.BOTTEGA_CONFIG_HOME = configHome
  })

  afterEach(() => {
    if (previousConfigHome === undefined) delete process.env.BOTTEGA_CONFIG_HOME
    else process.env.BOTTEGA_CONFIG_HOME = previousConfigHome
    rmSync(configHome, { recursive: true, force: true })
  })

  test('reports that the check is switched off', async () => {
    writeFileSync(join(configHome, 'machine.toml'), 'prose = { check = "off" }\n')
    expect(
      await orchestratorProseGate([{ field: 'body', text: ['me', 'ida'].join(''), prior: null }]),
    ).toEqual({ refusal: null, notices: ['Spelling and grammar check is switched off'] })
  })

  test('turns an invalid configured value into a did-not-run notice', async () => {
    writeFileSync(join(configHome, 'machine.toml'), 'prose = { check = "invalid" }\n')
    const result = await orchestratorProseGate([{ field: 'body', text: 'Text.', prior: null }])
    expect(result.refusal).toBeNull()
    expect(result.notices).toEqual([
      expect.stringContaining('Spelling and grammar check did not run:'),
    ])
  })

  test('runs the gate by default', async () => {
    const misspelling = ['me', 'ida'].join('')
    const result = await orchestratorProseGate([
      { field: 'body', text: `We saw the ${misspelling} here.`, prior: null },
    ])
    expect(result.refusal).toContain(`body:\n"${misspelling}"`)
    expect(result.notices).toEqual([])
  })
})
