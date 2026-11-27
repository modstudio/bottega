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
import type { Project } from '../project/projects.ts'
import { runTempDir, writingRunTempDir } from '../run-owned-paths.ts'
import {
  resetSandbox,
  sandboxLaunchArgv,
  writerProfile,
  writingAcpWritableRoots,
} from '../sandbox/sandbox.ts'
import { srtLibrary } from '../sandbox/sandbox-runtime.ts'
import { prepareRunTemp } from './run-temp.ts'

test('run temp is private and refuses paths that are not real directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-temp-claim-'))
  try {
    const readerRuntime = join(root, 'reader')
    const readerTemp = runTempDir(readerRuntime)
    prepareRunTemp(readerTemp)
    const readerStat = lstatSync(readerTemp)
    expect(readerStat.isDirectory()).toBe(true)
    expect(readerStat.isSymbolicLink()).toBe(false)
    expect(readerStat.mode & 0o777).toBe(0o700)

    const writerScratch = join(root, 'writer')
    const writerTemp = writingRunTempDir(writerScratch)
    prepareRunTemp(writerTemp)
    expect(existsSync(writerTemp)).toBe(true)

    const symlinkRuntime = join(root, 'symlink')
    mkdirSync(symlinkRuntime)
    symlinkSync(readerTemp, join(symlinkRuntime, 'tmp'))
    expect(() => prepareRunTemp(join(symlinkRuntime, 'tmp'))).toThrow(
      'is not a real directory; remedy: remove it and retry the run',
    )

    const fileRuntime = join(root, 'file')
    mkdirSync(fileRuntime)
    writeFileSync(join(fileRuntime, 'tmp'), '')
    expect(() => prepareRunTemp(join(fileRuntime, 'tmp'))).toThrow(
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
      const worktree = join(root, 'worktree')
      const scratchDir = join(root, 'scratch')
      const runtimeDir = join(root, 'runtime')
      mkdirSync(worktree, { recursive: true })
      mkdirSync(scratchDir, { recursive: true })
      const project: Project = {
        recordId: '01990000-0000-7000-8000-000000001214',
        name: 'fixture',
        path: worktree,
        stack: 'node',
        canon: true,
        retiredAt: null,
        settings: {},
      }
      const temporaryDirectory = writingRunTempDir(scratchDir)
      const profile = writerProfile({
        worktree,
        runtimeDir,
        scratchDir,
        askAddress: join(scratchDir, 'ask.sock'),
        project,
        registeredProjects: [project],
        agent: 'codex',
        socketDenyPaths: [],
      })
      expect(profile.filesystem.allowWrite).toEqual(
        writingAcpWritableRoots(worktree, scratchDir, runtimeDir),
      )
      prepareRunTemp(temporaryDirectory)
      expect(existsSync(temporaryDirectory)).toBe(true)
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
