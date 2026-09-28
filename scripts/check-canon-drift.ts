import type { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { collectCanonTreeAtRef, isHydrationPath } from '../orchestrator/src/canon/canon-files.ts'
import {
  type HydrationDrift,
  hydrationDrift,
  planHydration,
} from '../orchestrator/src/canon/canon-hydrate.ts'
import { storedRepositoryCanonRows } from '../orchestrator/src/canon/canon-stored-rows.ts'
import { CODEX_PROJECT_DOC_PATH } from '../orchestrator/src/canon/codex-project-doc.ts'
import { DB_PATH, openReadOnlyDatabase } from '../orchestrator/src/database/db.ts'
import { type Project, projectAt } from '../orchestrator/src/project/projects.ts'
import { resolveRegisteredLandingBase } from './landing-base.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const remedy =
  'edit canon in the store with orch doc set, then run orch canon hydrate in the worktree and commit'

function run(argv: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString().trim(),
  }
}

function refuse(condition: string): never {
  throw new Error(`${condition}\nremedy: ${remedy}`)
}

export function readCanonGateInput(
  checkout: string,
  database: Database,
): { project: Project; rows: ReturnType<typeof storedRepositoryCanonRows> } {
  const project = projectAt(checkout, database)
  if (!project) refuse(`cannot find the checkout ${checkout} in the project register`)
  if (!project.settings.trunk?.trim()) {
    refuse(`registered project ${project.name} has no landing branch in settings.trunk`)
  }
  return { project, rows: storedRepositoryCanonRows(project.name, database) }
}

export function branchChangedPaths(checkout: string, base: string): string[] {
  const diff = run(['git', 'diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], checkout)
  if (diff.exitCode !== 0) {
    refuse(`cannot read branch changes from merge-base ${base}: ${diff.stderr}`)
  }
  return diff.stdout.split('\0').filter(Boolean)
}

export function branchHydrationPaths(paths: Iterable<string>): string[] {
  const changed = [...paths].filter(isHydrationPath)
  if (
    changed.some((path) => path === 'AGENTS.md' || /^\.agents\/rules\/[^/]+\.md$/.test(path)) &&
    !changed.includes(CODEX_PROJECT_DOC_PATH)
  ) {
    changed.push(CODEX_PROJECT_DOC_PATH)
  }
  return changed
}

export function canonBranchFindings(input: {
  checkout: string
  base: string
  rows: ReturnType<typeof storedRepositoryCanonRows>
}): HydrationDrift[] {
  const changed = branchHydrationPaths(branchChangedPaths(input.checkout, input.base))
  if (changed.length === 0) return []
  const head = collectCanonTreeAtRef(input.checkout, 'HEAD')
  return hydrationDrift(planHydration({ rows: input.rows, tree: head.tree }), changed)
}

function checkCanonDrift(checkout: string, databasePath = DB_PATH): HydrationDrift[] {
  let database: Database
  try {
    database = openReadOnlyDatabase(databasePath)
  } catch (cause) {
    refuse(
      `cannot establish read-only access to the project register and canon store: ${String((cause as Error).message ?? cause)}`,
    )
  }
  try {
    const { project, rows } = readCanonGateInput(checkout, database)
    let base: string
    try {
      base = resolveRegisteredLandingBase(
        checkout,
        'canon drift check',
        project.settings.trunk!.trim(),
      ).commit
    } catch (cause) {
      refuse(String((cause as Error).message ?? cause))
    }
    return canonBranchFindings({ checkout, base, rows })
  } catch (cause) {
    if (String((cause as Error).message ?? cause).includes(`remedy: ${remedy}`)) throw cause
    refuse(
      `cannot read the project register or stored canon through a read-only connection: ${String((cause as Error).message ?? cause)}`,
    )
  } finally {
    database.close()
  }
}

if (import.meta.main) {
  try {
    const findings = checkCanonDrift(root)
    for (const finding of findings) {
      console.error(`${finding.path}: branch canon differs from stored canon; remedy: ${remedy}`)
    }
    if (findings.length) process.exitCode = 1
  } catch (cause) {
    console.error(String((cause as Error).message ?? cause))
    process.exitCode = 1
  }
}
