import { expect, test } from 'bun:test'
import {
  type ConfinementReportAgent,
  type ConfinementReportRow,
  confinementJobKindFromNeeds,
  formatConfinementReport,
  parseConfinementJobSelector,
  parseConfinementMcpSelector,
  reportConfinement,
} from './confinement-report.ts'
import { RECORD_CONNECTION_ENV_NAMES } from './record-connection-env.ts'

const grok: ConfinementReportAgent = {
  name: 'grok',
  harness: 'grok',
  enabled: true,
  readsRepo: true,
  writesRepo: true,
  mcp: true,
}

const codex: ConfinementReportAgent = {
  name: 'codex',
  harness: 'codex',
  enabled: true,
  readsRepo: true,
  writesRepo: true,
  mcp: true,
}

const reader: ConfinementReportAgent = {
  name: 'reader',
  harness: 'qwen',
  enabled: true,
  readsRepo: true,
  writesRepo: false,
  mcp: false,
}

const row = (
  agent: ConfinementReportAgent,
  job: 'reading' | 'writing',
  mcp: boolean,
  extra: Partial<Parameters<typeof reportConfinement>[0]> = {},
) =>
  reportConfinement({
    agents: [agent],
    parentEnvNames: [],
    job,
    mcp,
    ...extra,
  })[0]!

test('a Grok reading job without MCP is host-unconfined while srt still applies', () => {
  const reported = row(grok, 'reading', false)
  expect(reported.status).toBe('ok')
  if (reported.status !== 'ok') return
  expect(reported.confinement.sandbox).toBe('srt')
  expect(reported.envFile.access).toBe('denied')
  expect(reported.keychain).toEqual({
    access: 'denied',
    reason: 'srt denyRead includes the login keychain',
  })
  expect(reported.loopback.access).toBe('open')
  expect(reported.loopback.reason).toContain('orch has no denial')
})

test('MCP was requested; srt blocks MCP transports; run is unconfined', () => {
  const reported = row(grok, 'reading', true)
  expect(reported.status).toBe('ok')
  if (reported.status !== 'ok') return
  expect(reported.confinement).toEqual({
    sandbox: 'host',
    reason: 'MCP was requested; srt blocks MCP transports; run is unconfined',
  })
  expect(reported.envFile.access).toBe('open')
  expect(reported.keychain.access).toBe('open')
  expect(reported.loopback.access).toBe('open')
  expect(reported.keychain.reason).toBe('orch has no denial')
})

test('writing jobs stay on the host seam and look confined', () => {
  const reported = row(grok, 'writing', false)
  expect(reported.status).toBe('ok')
  if (reported.status !== 'ok') return
  expect(reported.confinement.sandbox).toBe('host')
  expect(reported.confinement.reason).toBe('writing jobs are not readonly-sandbox candidates')
  expect(reported.envFile.access).toBe('open')
  expect(reported.keychain.access).toBe('open')
  expect(reported.loopback.reason).toBe('orch has no denial')
})

test('an SRT profile that denies ~/.claude/.env reports the env file as open', () => {
  const reported = row(reader, 'reading', false)
  expect(reported.status).toBe('ok')
  if (reported.status !== 'ok') return
  expect(reported.confinement.sandbox).toBe('srt')
  expect(reported.envFile).toEqual({
    access: 'denied',
    reason: 'srt denyRead includes the operator env file',
  })
})

test('childEnv forwards ORCH_RECORD_URL and ORCH_RECORD_MIGRATE_URL into the withheld list', () => {
  const reported = row(grok, 'reading', false, {
    parentEnvNames: ['ORCH_RECORD_URL', 'ORCH_RECORD_MIGRATE_URL', 'ORCH_DB'],
  })
  expect(reported.status).toBe('ok')
  if (reported.status !== 'ok') return
  expect(reported.withheldForwarded).toEqual([])
})

test('a writing shape for an agent that lacks writesRepo is reported as launchable', () => {
  const reported = row(reader, 'writing', false)
  expect(reported.status).toBe('refused')
  expect(reported.refusal).toBe('lacks writesRepo')
})

test('MCP requested of an agent that lacks MCP is reported as launchable', () => {
  const reported = row(reader, 'reading', true)
  expect(reported.status).toBe('refused')
  expect(reported.refusal).toBe('lacks mcp')
})

test('no selector prints every enabled repository-capable agent x reading or writing x MCP', () => {
  const rows = reportConfinement({ agents: [grok, reader, codex], parentEnvNames: [] })
  expect(rows.map((item) => `${item.agent}:${item.job}:${item.mcp}`)).toEqual([
    'grok:reading:false',
    'grok:reading:true',
    'grok:writing:false',
    'grok:writing:true',
    'reader:reading:false',
    'reader:reading:true',
    'reader:writing:false',
    'reader:writing:true',
    'codex:reading:false',
    'codex:reading:true',
    'codex:writing:false',
    'codex:writing:true',
  ])
})

test('--agent --job --mcp are ignored and every shape is still printed', () => {
  const rows = reportConfinement({
    agents: [grok, codex],
    parentEnvNames: [],
    agent: 'grok',
    job: 'reading',
    mcp: false,
  })
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ agent: 'grok', job: 'reading', mcp: false })
})

test('an unknown --agent is reported as an empty table', () => {
  expect(() => reportConfinement({ agents: [grok], parentEnvNames: [], agent: 'nosuch' })).toThrow(
    'unknown agent "nosuch"',
  )
})

test('implement is not classified as a writing job', () => {
  expect(confinementJobKindFromNeeds({ readsRepo: true, writesRepo: true })).toBe('writing')
  expect(confinementJobKindFromNeeds({ readsRepo: true })).toBe('reading')
  expect(confinementJobKindFromNeeds({ readsRepo: false })).toBeNull()
  expect(
    parseConfinementJobSelector('implement', { implement: { needs: { writesRepo: true } } }),
  ).toBe('writing')
  expect(
    parseConfinementJobSelector('diagnose', { diagnose: { needs: { readsRepo: true } } }),
  ).toBe('reading')
  expect(() =>
    parseConfinementJobSelector('summarize', { summarize: { needs: { readsRepo: false } } }),
  ).toThrow('summarize is not a reading or writing repository job')
  expect(parseConfinementMcpSelector(false, undefined)).toBeUndefined()
  expect(parseConfinementMcpSelector(true, undefined)).toBe(true)
  expect(parseConfinementMcpSelector(true, 'false')).toBe(false)
})

test('--json prints a different document than the row data', () => {
  const rows = reportConfinement({
    agents: [grok],
    parentEnvNames: [],
    job: 'reading',
    mcp: false,
  })
  expect(JSON.parse(formatConfinementReport(rows, true)[0]!)).toEqual(rows)
  const text = formatConfinementReport(rows, false)
  expect(text[0]).toContain('grok  reading  mcp=no  srt')
  expect(text.some((line) => line.includes('env-file') && line.includes('denied'))).toBe(true)
})

test('envFileAccess returns open for a grok reading run under srt because it checks the home link first', () => {
  const srt = row(grok, 'reading', false)
  expect(srt.status).toBe('ok')
  if (srt.status !== 'ok') return
  expect(srt.envFile).toEqual({
    access: 'denied',
    reason: 'srt denyRead includes the operator env file; the worker-home link resolves to it',
  })
  const host = row(grok, 'reading', true)
  expect(host.status).toBe('ok')
  if (host.status !== 'ok') return
  expect(host.envFile).toEqual({
    access: 'open',
    reason: 'orch has no denial; worker HOME links the operator env file',
  })
})

test('codex rows read host loopback open: orch has no denial', () => {
  for (const job of ['reading', 'writing'] as const) {
    for (const mcp of [false, true]) {
      const reported = row(codex, job, mcp)
      expect(reported.status).toBe('ok')
      if (reported.status !== 'ok') continue
      expect(reported.confinement).toEqual({
        sandbox: 'workspace-write',
        reason: 'codex native sandbox',
      })
      expect(reported.loopback).toEqual({
        access: 'denied',
        reason: 'codex workspace-write has network_access off',
      })
      expect(reported.envFile).toEqual({
        access: 'open',
        reason: 'orch passes codex no read denial',
      })
      expect(reported.keychain).toEqual({
        access: 'open',
        reason: 'orch passes codex no read denial',
      })
    }
  }
})

test('the named-secret line hardcodes ORCH_RECORD_URL into one sentence', () => {
  const reported = row(grok, 'reading', false)
  expect(reported.status).toBe('ok')
  if (reported.status !== 'ok') return
  expect(reported.namedSecret.recordConnection.access).toBe('denied')
  expect(reported.namedSecret.other).toEqual({ access: 'open', reason: 'orch has no denial' })
  for (const name of RECORD_CONNECTION_ENV_NAMES) {
    expect(reported.namedSecret.recordConnection.reason).toContain(name)
  }
  expect(reported.namedSecret.recordConnection.reason).toContain(
    'record database connections are withheld from workers; the architect session runs work that needs one',
  )
  const parsed = JSON.parse(formatConfinementReport([reported], true)[0]!) as ConfinementReportRow[]
  const named = parsed[0]
  expect(named?.status).toBe('ok')
  if (named?.status !== 'ok') return
  expect(named.namedSecret.recordConnection).toBeDefined()
  expect(named.namedSecret.other).toBeDefined()
  expect('reason' in named.namedSecret).toBe(false)
})

test('a refused shape still prints access lines', () => {
  const reported = row(reader, 'writing', false)
  expect(reported).toEqual({
    agent: 'reader',
    job: 'writing',
    mcp: false,
    status: 'refused',
    refusal: 'lacks writesRepo',
  })
  expect(formatConfinementReport([reported], false)).toEqual([
    'reader  writing  mcp=no  refused  lacks writesRepo',
  ])
  expect(JSON.parse(formatConfinementReport([reported], true)[0]!)).toEqual([reported])
})

test('withheld: (none) is printed in every heading', () => {
  const reported = row(grok, 'reading', false)
  expect(reported.status).toBe('ok')
  if (reported.status !== 'ok') return
  const text = formatConfinementReport([reported], false)
  expect(text[0]).not.toContain('withheld')
  const warned = formatConfinementReport(
    [{ ...reported, withheldForwarded: ['ORCH_RECORD_URL'] }],
    false,
  )
  expect(warned[0]).not.toContain('withheld')
  expect(warned.some((line) => line.includes('warning') && line.includes('ORCH_RECORD_URL'))).toBe(
    true,
  )
})
