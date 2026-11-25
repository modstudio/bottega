import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import {
  canonDriftStoreSource,
  classifyStore,
  liveStorePath,
  localGateRegistration,
  migrateStore,
  snapshotStore,
  withBranchStoreScratch,
  withMainGateFactsSnapshot,
} from '../orchestrator/scripts/branch-store.ts'
import {
  EMPTY_PROJECT_CANON_IMPORT_REMEDY,
  EMPTY_PROJECT_CANON_STORE_CONDITION,
} from '../orchestrator/src/canon/canon-empty-store-refusal.ts'
import { collectCanonTreeAtRef, isHydrationPath } from '../orchestrator/src/canon/canon-files.ts'
import {
  type AddressedCanonRow,
  emptyStoreHydrationRefusal,
  type HydrationDrift,
  hydrationDrift,
  planHydration,
} from '../orchestrator/src/canon/canon-hydrate.ts'
import { storedRepositoryCanonRows } from '../orchestrator/src/canon/canon-stored-rows.ts'
import { CODEX_PROJECT_DOC_PATH } from '../orchestrator/src/canon/codex-project-doc.ts'
import { DB_PATH, withSynchronousReadOnlyDatabase } from '../orchestrator/src/database/db.ts'
import { migrationRefusal } from '../orchestrator/src/database/migrations.ts'
import {
  type GateFacts,
  projectAtGateFacts,
  readGateFactsFile,
} from '../orchestrator/src/gate/gate-facts.ts'
import { type Project, projectAt } from '../orchestrator/src/project/projects.ts'
import { startBoundedSync } from '../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { exitUnchecked } from '../shared/check-execution.ts'
import { inspectionGitEnv } from '../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'
import { resolveRegisteredLandingBase } from './landing-base.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const remedy = `edit canon in the store with ${PLATFORM_SLUG} doc set, then run ${PLATFORM_SLUG} doc canon hydrate in the worktree and commit`

function run(argv: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const result = startBoundedSync(argv, {
    budget: 'git-plumbing',
    cwd,
    env: inspectionGitEnv(),
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString().trim(),
  }
}

function runWithStore(store: string): number {
  const child = startBoundedSync([process.execPath, fileURLToPath(import.meta.url)], {
    budget: 'self-cli',
    env: { ...process.env, BOTTEGA_ORCHESTRATOR_DB: store },
  })
  process.stdout.write(child.stdout)
  process.stderr.write(child.stderr)
  return child.exitCode
}

function refuse(condition: string, namedRemedy = remedy): never {
  throw new Error(`${condition}\nremedy: ${namedRemedy}`)
}

export function registeredProjectAt(checkout: string, database: Database): Project {
  const project = projectAt(checkout, database)
  if (!project) refuse(`cannot find the checkout ${checkout} in the project register`)
  if (!project.settings.trunk?.trim()) {
    refuse(`registered project ${project.name} has no landing branch in settings.trunk`)
  }
  return project
}

export async function readCanonGateInput(
  checkout: string,
  database: Database,
): Promise<{ project: Project; rows: Awaited<ReturnType<typeof storedRepositoryCanonRows>> }> {
  const project = registeredProjectAt(checkout, database)
  return { project, rows: await storedRepositoryCanonRows(project.name, database) }
}

function readCanonGateFactsInput(
  checkout: string,
  facts: GateFacts,
): { project: Project; rows: { slug: string; body: string; subject: string | null }[] } {
  const project = projectAtGateFacts(checkout, facts)
  if (!project) refuse(`cannot find the checkout ${checkout} in the project register`)
  if (!project.settings.trunk?.trim()) {
    refuse(`registered project ${project.name} has no landing branch in settings.trunk`)
  }
  return {
    project,
    rows: facts.docs.filter(
      (doc) => doc.scope === 'canon' && (doc.subject === null || doc.subject === project.name),
    ),
  }
}

export function branchChangedPaths(checkout: string, base: string): string[] {
  const diff = run(
    ['git', ...nulPathListArgs(['diff', '--no-renames', '--name-only', base, 'HEAD'])],
    checkout,
  )
  if (diff.exitCode !== 0) {
    refuse(`cannot read branch changes from merge-base ${base}: ${diff.stderr}`)
  }
  return splitNulPaths(diff.stdout)
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
  rows: AddressedCanonRow[]
}): HydrationDrift[] {
  const changed = branchHydrationPaths(branchChangedPaths(input.checkout, input.base))
  if (changed.length === 0) return []
  const head = collectCanonTreeAtRef(input.checkout, 'HEAD')
  return hydrationDrift(planHydration({ rows: input.rows, tree: head.tree }), changed)
}

export function canonEmptyStoreDriftRefusal(input: {
  projectRowCount: number
  deleteCount: number
}): { condition: string; remedy: string } | null {
  if (!emptyStoreHydrationRefusal(input)) return null
  return {
    condition: EMPTY_PROJECT_CANON_STORE_CONDITION,
    remedy: EMPTY_PROJECT_CANON_IMPORT_REMEDY,
  }
}

function canonDriftFromInput(
  checkout: string,
  input: { project: Project; rows: AddressedCanonRow[] },
): HydrationDrift[] {
  const { project, rows } = input
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
  const findings = canonBranchFindings({ checkout, base, rows })
  if (findings.length === 0) return findings
  const plan = planHydration({
    rows,
    tree: collectCanonTreeAtRef(checkout, 'HEAD').tree,
  })
  const emptyStore = canonEmptyStoreDriftRefusal({
    projectRowCount: rows.filter((row) => row.subject === project.name).length,
    deleteCount: plan.deletes.length,
  })
  if (emptyStore) refuse(emptyStore.condition, emptyStore.remedy)
  return findings
}

async function checkCanonDrift(
  checkout: string,
  databasePath = DB_PATH,
  facts?: GateFacts,
): Promise<HydrationDrift[]> {
  if (facts) return canonDriftFromInput(checkout, readCanonGateFactsInput(checkout, facts))
  try {
    const input = await withSynchronousReadOnlyDatabase(
      (database) => readCanonGateInput(checkout, database),
      databasePath,
    )
    return canonDriftFromInput(checkout, input)
  } catch (cause) {
    if (String((cause as Error).message ?? cause).includes('\nremedy: ')) throw cause
    refuse(
      `cannot read the project register or stored canon through a read-only connection: ${String((cause as Error).message ?? cause)}`,
    )
  }
}

if (import.meta.main) {
  try {
    const live = liveStorePath()
    const registration = localGateRegistration(root, live)
    if (registration.kind === 'skip') {
      exitUnchecked(registration.message)
    }
    if (registration.kind === 'fail') throw new Error(registration.message)
    const storeKind = classifyStore(live)
    const source = canonDriftStoreSource(storeKind)
    if (source.kind === 'migrated-scratch') {
      const code = withBranchStoreScratch('canon-drift', (dir) => {
        const snapshot = snapshotStore(live!, dir)
        migrateStore(snapshot)
        return runWithStore(snapshot)
      })
      process.exitCode = code
    } else {
      const findings = await (source.kind === 'gate-facts'
        ? withBranchStoreScratch('canon-drift', (dir) =>
            withMainGateFactsSnapshot(
              storeKind,
              dir,
              (snapshotError) => {
                const database = new Database(live!, { readonly: true })
                try {
                  throw new Error(
                    `${migrationRefusal(database)}\n${String((snapshotError as Error).message ?? snapshotError)}`,
                  )
                } finally {
                  database.close()
                }
              },
              (snapshot) => {
                console.log(
                  `canon drift: gate-facts snapshot took ${snapshot.elapsedMs.toFixed(1)} ms`,
                )
                return checkCanonDrift(root, DB_PATH, readGateFactsFile(snapshot.path))
              },
            ),
          )
        : checkCanonDrift(root))
      for (const finding of findings) {
        console.error(`${finding.path}: branch canon differs from stored canon; remedy: ${remedy}`)
      }
      if (findings.length) process.exitCode = 1
    }
  } catch (cause) {
    console.error(String((cause as Error).message ?? cause))
    process.exitCode = 1
  }
}
