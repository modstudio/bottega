/**
 * Opt-in test instrumenter. Activated by ORCH_GATE_TIMINGS (a JSON path, or
 * any non-empty value to auto-place under the orchestrator state directory).
 *
 * Counts Bun.spawn / Bun.spawnSync and fixture-store bootstraps per test file
 * via wrappers. Per-test wall times come from bun's junit reporter, merged by
 * record-gate-timings.ts after the run. Default `bun test` is unchanged: this
 * file is only preloaded when the recorder asks for it.
 */

import { Database } from 'bun:sqlite'
import { afterAll } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { concernStateDirectory } from '../../shared/state-directory.ts'

const enabled = process.env.ORCH_GATE_TIMINGS
if (enabled) {
  const orchRoot = join(import.meta.dir, '..')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath =
    enabled.includes('/') || enabled.endsWith('.json')
      ? enabled
      : join(concernStateDirectory('orchestrator'), 'runs', 'gate-timings', `${stamp}.json`)
  const sidecarPath = `${outPath}.spawn.json`

  type Kind = 'cli' | 'git' | 'other'
  type FileCounts = {
    spawn: number
    spawnSync: number
    bootstraps: number
    cli: number
    git: number
    other: number
    argv0: Record<string, number>
  }

  const files = new Map<string, FileCounts>()
  const started = Date.now()

  function empty(): FileCounts {
    return { spawn: 0, spawnSync: 0, bootstraps: 0, cli: 0, git: 0, other: 0, argv0: {} }
  }

  function rel(path: string): string {
    const raw = path.startsWith('file://') ? fileURLToPath(path) : path
    const fromRoot = relative(orchRoot, raw)
    if (fromRoot && !fromRoot.startsWith('..') && fromRoot !== raw) return fromRoot
    if (raw.startsWith('src/')) return raw
    const idx = raw.lastIndexOf('/src/')
    if (idx !== -1) return raw.slice(idx + 1)
    return raw
  }

  function callerFile(): string {
    const stack = new Error().stack ?? ''
    let found = '(process)'
    for (const match of stack.matchAll(/(?:file:\/\/)?(\/[^:)\s]+\.test\.ts)/g)) {
      const path = match[1]!
      if (path.includes('gate-timings')) continue
      found = rel(path)
    }
    return found
  }

  function counts(file = callerFile()): FileCounts {
    const existing = files.get(file)
    if (existing) return existing
    const created = empty()
    files.set(file, created)
    return created
  }

  function argvOf(cmd: unknown): string[] {
    if (Array.isArray(cmd)) return cmd.map(String)
    if (typeof cmd === 'string') return [cmd]
    return []
  }

  function basename(arg: string): string {
    const slash = Math.max(arg.lastIndexOf('/'), arg.lastIndexOf('\\'))
    return slash === -1 ? arg : arg.slice(slash + 1)
  }

  function classify(argv: string[]): Kind {
    if (argv.some((arg) => /(^|[\\/])cli\.ts$/.test(arg))) return 'cli'
    if (basename(argv[0] ?? '') === 'git') return 'git'
    return 'other'
  }

  function recordSpawn(kind: 'spawn' | 'spawnSync', cmd: unknown) {
    const row = counts()
    row[kind]++
    const argv = argvOf(cmd)
    const bucket = classify(argv)
    row[bucket]++
    const head = basename(argv[0] ?? '(none)')
    row.argv0[head] = (row.argv0[head] ?? 0) + 1
  }

  const origSpawn = Bun.spawn.bind(Bun)
  const origSpawnSync = Bun.spawnSync.bind(Bun)
  Bun.spawn = ((cmd: Parameters<typeof Bun.spawn>[0], opts?: Parameters<typeof Bun.spawn>[1]) => {
    recordSpawn('spawn', cmd)
    return origSpawn(cmd, opts)
  }) as typeof Bun.spawn
  Bun.spawnSync = ((
    cmd: Parameters<typeof Bun.spawnSync>[0],
    opts?: Parameters<typeof Bun.spawnSync>[1],
  ) => {
    recordSpawn('spawnSync', cmd)
    return origSpawnSync(cmd, opts)
  }) as typeof Bun.spawnSync

  // bootstrapFixtureStore's first exec is this exact pragma; db() and migrate
  // always prefix busy_timeout on the same line, so the fingerprint is unique
  // among production open paths (initializeDatabase shares it, and is a bootstrap).
  const origExec = Database.prototype.exec
  Database.prototype.exec = function (this: Database, sql?: string) {
    if (sql === 'PRAGMA foreign_keys = ON;') counts().bootstraps++
    return origExec.call(this, sql as never)
  }

  function writeSidecar() {
    mkdirSync(dirname(sidecarPath), { recursive: true })
    const payload = {
      outPath,
      elapsedMs: Date.now() - started,
      files: Object.fromEntries(files),
    }
    writeFileSync(sidecarPath, JSON.stringify(payload, null, 2))
    process.env.ORCH_GATE_TIMINGS_SIDECAR = sidecarPath
  }

  afterAll(writeSidecar)
  process.on('exit', writeSidecar)
}
