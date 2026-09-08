import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CanonBudgetError, compilePack } from '../src/canon.ts'
import { DATABASE_RESOLUTION } from '../src/database-location.ts'
import { JOBS } from '../src/jobs.ts'
import { applyMigrations, migrationRefusal } from '../src/migrations.ts'
import { DEFAULT_PACK_BYTES } from '../src/pack-budget.ts'
import { projects } from '../src/projects.ts'

export function checkPackBudget(): string[] {
  const failures: string[] = []
  for (const project of projects()) {
    for (const job of Object.keys(JOBS)) {
      try { compilePack({ job, cwd: project.path }) }
      catch (error) {
        if (error instanceof CanonBudgetError) failures.push(`${project.name}/${job}\n${error.message}`)
        else throw error
      }
    }
  }
  return failures
}

const READY = 'ORCH_PACK_BUDGET_READY'

function report(failures: string[]): never {
  if (failures.length) {
    console.error(`canon pack budget failed for ${failures.length} project/job combination(s):\n${failures.join('\n\n')}`)
    process.exit(1)
  }
  console.log(`canon pack budget ok (ceiling ${DEFAULT_PACK_BYTES} bytes)`)
  process.exit(0)
}

function liveStorePath(): string | null {
  if (process.env.ORCH_DB) return existsSync(process.env.ORCH_DB) ? process.env.ORCH_DB : null
  for (const path of [DATABASE_RESOLUTION.mainStorePath, DATABASE_RESOLUTION.path]) {
    if (path && existsSync(path)) return path
  }
  return null
}

function storeKind(path: string): 'ok' | 'behind' | 'ahead' {
  const d = new Database(path, { readonly: true })
  try {
    d.exec('PRAGMA busy_timeout = 15000')
    const refused = migrationRefusal(d)
    if (!refused) return 'ok'
    return refused.includes('ahead of this binary') ? 'ahead' : 'behind'
  } finally {
    d.close()
  }
}

function scratchDir(): string {
  const base = process.env.ORCH_SCRATCH
    ? join(process.env.ORCH_SCRATCH, 'pack-budget')
    : join(tmpdir(), 'orch-pack-budget')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, 'copy-'))
}

function copyStore(src: string, destDir: string): string {
  const dest = join(destDir, 'orch.db')
  copyFileSync(src, dest)
  for (const side of ['-wal', '-shm'] as const) {
    if (existsSync(`${src}${side}`)) copyFileSync(`${src}${side}`, `${dest}${side}`)
  }
  return dest
}

function migrateCopy(path: string): void {
  const d = new Database(path)
  try {
    d.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    applyMigrations(d)
  } finally {
    d.close()
  }
}

function mintFixtureStore(destDir: string): string {
  const path = join(destDir, 'orch.db')
  const d = new Database(path, { create: true })
  try {
    d.exec('PRAGMA foreign_keys = ON;')
    applyMigrations(d)
  } finally {
    d.close()
  }
  return path
}

function runReady(store: string): number {
  const child = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url)], {
    env: { ...process.env, ORCH_DB: store, [READY]: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return child.exitCode ?? 1
}

function withScratch<T>(fn: (dir: string) => T): T {
  const dir = scratchDir()
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  if (process.env[READY] === '1') report(checkPackBudget())

  const live = liveStorePath()
  if (!live) {
    const code = withScratch((dir) => {
      const minted = mintFixtureStore(dir)
      console.log('canon pack budget: no live store; checking fixture-minted store')
      return runReady(minted)
    })
    process.exit(code)
  }

  const kind = storeKind(live)
  if (kind === 'ahead') {
    const d = new Database(live, { readonly: true })
    try { console.error(migrationRefusal(d)) }
    finally { d.close() }
    process.exit(1)
  }
  if (kind === 'ok') {
    console.log('canon pack budget: reading live store in place (read-only)')
    report(checkPackBudget())
  }

  const code = withScratch((dir) => {
    const copy = copyStore(live, dir)
    migrateCopy(copy)
    console.log('canon pack budget: copied live store, migrated the copy, checking packs there')
    return runReady(copy)
  })
  process.exit(code)
}
