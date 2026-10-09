import { expect, test } from 'bun:test'
import {
  type ConfinementReportAgent,
  confinementJobKindFromNeeds,
  formatConfinementReport,
  parseConfinementJobSelector,
  parseConfinementMcpSelector,
  reportConfinement,
} from './confinement-report.ts'

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
  expect(reported.confinement.sandbox).toBe('srt')
  expect(reported.envFile.access).toBe('open')
  expect(reported.envFile.reason).toContain('orch has no denial')
  expect(reported.envFile.reason).toContain('worker HOME links the operator env file')
  expect(reported.keychain).toEqual({
    access: 'denied',
    reason: 'srt denyRead includes the login keychain',
  })
  expect(reported.loopback.access).toBe('open')
  expect(reported.loopback.reason).toContain('orch has no denial')
})

test('MCP was requested; srt blocks MCP transports; run is unconfined', () => {
  const reported = row(grok, 'reading', true)
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
  expect(reported.confinement.sandbox).toBe('host')
  expect(reported.confinement.reason).toBe('writing jobs are not readonly-sandbox candidates')
  expect(reported.envFile.access).toBe('open')
  expect(reported.keychain.access).toBe('open')
  expect(reported.loopback.reason).toBe('orch has no denial')
})

test('codex reading jobs stay on the host seam', () => {
  const reported = row(codex, 'reading', false)
  expect(reported.confinement.sandbox).toBe('host')
  expect(reported.confinement.reason).toBe('codex is not a readonly-sandbox candidate')
  expect(reported.envFile.reason).toBe('orch has no denial')
})

test('an SRT profile that denies ~/.claude/.env reports the env file as open', () => {
  const reported = row(reader, 'reading', false)
  expect(reported.confinement.sandbox).toBe('srt')
  expect(reported.envFile).toEqual({
    access: 'denied',
    reason: 'srt denyRead includes the operator env file',
  })
  expect(reported.namedSecret.access).toBe('open')
  expect(reported.namedSecret.reason).toContain('orch has no denial')
  expect(reported.namedSecret.reason).toContain('withheld from workers')
})

test('childEnv forwards ORCH_RECORD_URL and ORCH_RECORD_MIGRATE_URL into the withheld list', () => {
  const reported = row(grok, 'reading', false, {
    parentEnvNames: ['ORCH_RECORD_URL', 'ORCH_RECORD_MIGRATE_URL', 'ORCH_DB'],
  })
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
  expect(reported.confinement.reason).toBe(
    'MCP was requested; srt blocks MCP transports; run is unconfined',
  )
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
  expect(text.some((line) => line.includes('env-file') && line.includes('open'))).toBe(true)
})
