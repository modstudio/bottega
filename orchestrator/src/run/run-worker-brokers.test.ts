import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workerBrokerConfinement, workerBrokerEnvironment } from './run-worker-brokers.ts'

test('worker broker confinement prepares temp only for srt', () => {
  const hostScratch = mkdtempSync(join(tmpdir(), 'broker-host-'))
  const srtScratch = mkdtempSync(join(tmpdir(), 'broker-srt-'))
  try {
    expect(workerBrokerConfinement({ writingAcp: false, scratchDir: hostScratch }, null)).toEqual({
      kind: 'host',
    })
    expect(existsSync(join(hostScratch, 'tmp'))).toBe(false)

    const profile = {} as never
    const confinement = workerBrokerConfinement(
      { writingAcp: true, scratchDir: srtScratch },
      profile,
    )
    expect(confinement).toEqual({
      kind: 'srt',
      profile,
      temporaryDirectory: join(srtScratch, 'tmp'),
    })
    expect(existsSync(join(srtScratch, 'tmp'))).toBe(true)
  } finally {
    rmSync(hostScratch, { recursive: true, force: true })
    rmSync(srtScratch, { recursive: true, force: true })
  }
})

test('worker broker environment scopes every temp variable only for srt', () => {
  const temporaryDirectory = '/scratch/run/tmp'
  const host = workerBrokerEnvironment({
    environment: { PATH: '/bin' },
    scratchDir: '/scratch/run',
    confinement: { kind: 'host' },
  })
  const srt = workerBrokerEnvironment({
    environment: { PATH: '/bin' },
    scratchDir: '/scratch/run',
    confinement: { kind: 'srt', profile: {} as never, temporaryDirectory },
  })

  for (const name of ['TMPDIR', 'TMP', 'TEMP', 'CLAUDE_CODE_TMPDIR']) {
    expect(host).not.toHaveProperty(name)
    expect(srt).toHaveProperty(name, temporaryDirectory)
  }
})
