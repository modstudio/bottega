import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { INSTALL_HOME_ENV } from '../../shared/install-root.ts'
import { projectListProcessError } from './orch-project-register.ts'

test('orchestrator resolution accepts only executable files from override, checkout, and PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-orch-resolution-'))
  const bundledRoot = join(root, 'checkout')
  const outputDir = join(bundledRoot, 'hub', 'src')
  mkdirSync(outputDir, { recursive: true })
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL('orch-project-register.ts', import.meta.url))],
    outdir: outputDir,
    target: 'bun',
    format: 'esm',
  })
  expect(built.success).toBe(true)
  const checkoutCandidate = join(bundledRoot, 'bin', PLATFORM_SLUG)
  mkdirSync(checkoutCandidate, { recursive: true })
  const first = join(root, 'first-bin')
  const second = join(root, 'second-bin')
  mkdirSync(join(first, PLATFORM_SLUG), { recursive: true })
  mkdirSync(second)
  const found = join(second, PLATFORM_SLUG)
  writeFileSync(found, '#!/bin/sh\nexit 0\n')
  chmodSync(found, 0o755)
  const override = join(root, 'override-orch')
  mkdirSync(override)
  const priorOrch = process.env.BOTTEGA_ORCH
  const priorPath = process.env.PATH
  const priorHome = process.env[INSTALL_HOME_ENV]
  try {
    process.env[INSTALL_HOME_ENV] = bundledRoot
    process.env.BOTTEGA_ORCH = override
    process.env.PATH = `${first}:${second}`
    const bundled = await import(`${built.outputs[0]!.path}?test=${Date.now()}`)
    expect(bundled.resolveOrchExecutable()).toBe(found)

    process.env.PATH = first
    expect(() => bundled.resolveOrchExecutable()).toThrow(
      `BOTTEGA_ORCH override ${override}; checkout executable ${checkoutCandidate}; PATH lookup found nothing`,
    )
    delete process.env.BOTTEGA_ORCH
    expect(() => bundled.resolveOrchExecutable()).toThrow('BOTTEGA_ORCH override unset')
    expect(() => bundled.resolveOrchExecutable()).not.toThrow(/at call time|restart|moved|renamed/)
  } finally {
    if (priorOrch === undefined) delete process.env.BOTTEGA_ORCH
    else process.env.BOTTEGA_ORCH = priorOrch
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorHome === undefined) delete process.env[INSTALL_HOME_ENV]
    else process.env[INSTALL_HOME_ENV] = priorHome
    rmSync(root, { recursive: true, force: true })
  }
})

describe('projectListProcessError', () => {
  test('names the timed-out lookup and its register remedy', () => {
    const error = projectListProcessError({
      command: `${PLATFORM_SLUG} project list --json`,
      exitCode: null,
      signalCode: 'SIGTERM',
      exitedDueToTimeout: true,
      stderr: '',
      stdout: '',
      timeoutMs: 20_000,
    })
    expect(error).toContain('project list --json')
    expect(error).toContain('timed out after 20000 ms')
    expect(error).toContain('retry once the register responds')
  })

  test('names a signal-only failure and its register remedy', () => {
    expect(
      projectListProcessError({
        command: `${PLATFORM_SLUG} project list --json`,
        exitCode: null,
        signalCode: 'SIGKILL',
        exitedDueToTimeout: false,
        stderr: '',
        stdout: '',
        timeoutMs: 20_000,
      }),
    ).toBe(
      `${PLATFORM_SLUG} project list --json ended on signal SIGKILL; retry once the register responds`,
    )
  })

  test('accepts a successful exit despite a raced timeout flag', () => {
    expect(
      projectListProcessError({
        command: `${PLATFORM_SLUG} project list --json`,
        exitCode: 0,
        signalCode: null,
        exitedDueToTimeout: true,
        stderr: '',
        stdout: '[]',
        timeoutMs: 20_000,
      }),
    ).toBeNull()
  })

  test('keeps stderr for a non-zero numeric exit', () => {
    expect(
      projectListProcessError({
        command: `${PLATFORM_SLUG} project list --json`,
        exitCode: 2,
        signalCode: null,
        exitedDueToTimeout: false,
        stderr: 'register unavailable\n',
        stdout: 'ignored output',
        timeoutMs: 20_000,
      }),
    ).toBe('register unavailable')
  })

  test('names the command for a non-zero numeric exit without process output', () => {
    expect(
      projectListProcessError({
        command: `${PLATFORM_SLUG} project list --json`,
        exitCode: 2,
        signalCode: null,
        exitedDueToTimeout: false,
        stderr: '',
        stdout: '',
        timeoutMs: 20_000,
      }),
    ).toBe(`${PLATFORM_SLUG} project list --json exited 2`)
  })
})
