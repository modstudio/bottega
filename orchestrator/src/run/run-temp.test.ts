import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTempDir } from '../run-owned-paths.ts'
import { resetSandbox, type SandboxRuntimeConfig, sandboxLaunchArgv } from '../sandbox/sandbox.ts'
import { srtLibrary } from '../sandbox/sandbox-runtime.ts'
import { prepareRunTemp } from './run-temp.ts'

test('run temp is private and refuses paths that are not real directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-temp-claim-'))
  try {
    const readerRuntime = join(root, 'reader')
    prepareRunTemp(readerRuntime)
    const readerTemp = join(readerRuntime, 'tmp')
    const readerStat = lstatSync(readerTemp)
    expect(readerStat.isDirectory()).toBe(true)
    expect(readerStat.isSymbolicLink()).toBe(false)
    expect(readerStat.mode & 0o777).toBe(0o700)

    const writerRuntime = join(root, 'writer')
    prepareRunTemp(writerRuntime)
    expect(existsSync(join(writerRuntime, 'tmp'))).toBe(true)

    const symlinkRuntime = join(root, 'symlink')
    mkdirSync(symlinkRuntime)
    symlinkSync(readerTemp, join(symlinkRuntime, 'tmp'))
    expect(() => prepareRunTemp(symlinkRuntime)).toThrow(
      'is not a real directory; remedy: remove it and retry the run',
    )

    const fileRuntime = join(root, 'file')
    mkdirSync(fileRuntime)
    writeFileSync(join(fileRuntime, 'tmp'), '')
    expect(() => prepareRunTemp(fileRuntime)).toThrow(
      'is not a real directory; remedy: remove it and retry the run',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('confined run temp', () => {
  const fallback = join(tmpdir(), `run-temp-missing-fallback-${process.pid}`)
  const previousFallback = process.env.CLAUDE_TMPDIR
  beforeEach(() => {
    rmSync(fallback, { recursive: true, force: true })
    process.env.CLAUDE_TMPDIR = fallback
  })
  afterEach(() => {
    if (previousFallback === undefined) delete process.env.CLAUDE_TMPDIR
    else process.env.CLAUDE_TMPDIR = previousFallback
    rmSync(fallback, { recursive: true, force: true })
  })

  test.skipIf(!existsSync(srtLibrary()))(
    'a confined writer can create a file in its existing run temp when the fallback is missing',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'run-temp-launch-'))
      const runtimeDir = join(root, 'runtime')
      const temporaryDirectory = runTempDir(runtimeDir)
      const profile: SandboxRuntimeConfig = {
        network: {
          allowedDomains: [],
          deniedDomains: [],
          allowUnixSockets: [],
          allowLocalBinding: false,
        },
        filesystem: {
          denyRead: [],
          allowWithinDeny: [],
          allowWrite: [runtimeDir],
          denyWrite: [],
        },
      }
      prepareRunTemp(runtimeDir)
      try {
        const environment = { ...process.env, CLAUDE_TMPDIR: fallback }
        const launch = await sandboxLaunchArgv(
          profile,
          '/bin/sh',
          ['-c', 'test -d "$TMPDIR" && touch "$TMPDIR/probe" && printf %s "$TMPDIR"'],
          temporaryDirectory,
          environment,
        )
        const result = Bun.spawnSync(launch, { env: environment })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toBe(temporaryDirectory)
        expect(existsSync(join(temporaryDirectory, 'probe'))).toBe(true)
        expect(existsSync(fallback)).toBe(false)
      } finally {
        await resetSandbox()
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
