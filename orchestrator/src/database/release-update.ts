// concern: installed release update adapter
/** Downloads, verifies, probes, stages, swaps, and migrates one installed release. */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { DistributionManifest } from '../../../shared/install-root.ts'
import {
  DEFAULT_RELEASE_DOWNLOAD_ROOT,
  DOWNLOAD_BASE_URL_ENV,
  releaseTarget,
} from '../../../shared/release-artifacts.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { MACHINE_JOURNAL_SCHEMA } from '../machine-journal.ts'
import { withSynchronousDatabaseForMigrationStep } from './db.ts'
import type { MigrationJournalEntry } from './migration-compatibility.ts'
import {
  candidateStoreDecision,
  digestMismatchRefusal,
  normalizeReleaseVersion,
  predatesUpdateRefusal,
  resolveReleaseVersion,
  storeAheadRefusal,
  unsupportedDownloadSchemeRefusal,
} from './release-update-decision.ts'

type Presentation = { log(value: string): void }

type PreparedReleaseUpdate = {
  decision: ReturnType<typeof candidateStoreDecision> & { state: 'positioned' }
  pendingMigration: string | null
  apply(): void
  cleanup(): void
}

export type ReleaseUpdatePreparation =
  | { action: 'current'; message: string }
  | { action: 'prepared'; update: PreparedReleaseUpdate }

function releaseUrl(root: string, path: string): URL {
  return new URL(path, `${root.replace(/\/+$/, '')}/`)
}

async function readDownload(url: URL): Promise<Uint8Array> {
  if (url.protocol === 'file:') return readFileSync(fileURLToPath(url))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(unsupportedDownloadSchemeRefusal(url.protocol))
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `download failed with HTTP ${response.status} for ${url}; retry, or check ${DOWNLOAD_BASE_URL_ENV}`,
    )
  }
  return new Uint8Array(await response.arrayBuffer())
}

function removeStaleStages(directory: string): void {
  const prefix = `.${PLATFORM_SLUG}-update.`
  for (const name of readdirSync(directory)) {
    if (name.startsWith(prefix)) rmSync(join(directory, name), { recursive: true, force: true })
  }
}

function candidateJournal(staged: string): MigrationJournalEntry[] {
  const state = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-update-probe.`))
  try {
    const env = { ...process.env, [STATE_HOME_ENV]: state }
    delete env.BOTTEGA_ORCHESTRATOR_DB
    delete env.BOTTEGA_ORCHESTRATOR_DB_WRITE
    delete env.BOTTEGA_HUB_DB
    const result = Bun.spawnSync([staged, 'machine', 'journal', '--json'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error('probe exited nonzero')
    const parsed = MACHINE_JOURNAL_SCHEMA.parse(JSON.parse(result.stdout.toString()))
    return parsed.orchestratorJournal.map((entry) => ({
      ...entry,
      compatibility: entry.compatibility ?? undefined,
    }))
  } catch {
    throw new Error(predatesUpdateRefusal('the requested version'))
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
}

function appliedMigrations(): { when: number; tag: string | null }[] {
  return withSynchronousDatabaseForMigrationStep((database) => {
    const table = database
      .query<{ present: number }, []>(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='orch_migrations'",
      )
      .get()
    if (!table) return []
    return database
      .query<{ created_at: number; version: string | null }, []>(
        'SELECT created_at,version FROM orch_migrations ORDER BY id',
      )
      .all()
      .map((row) => ({ when: Number(row.created_at), tag: row.version }))
  })
}

function migrateInstalledBinary(target: string): void {
  const result = Bun.spawnSync([target, 'machine', 'migrate'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `updated binary migration failed with exit ${result.exitCode}; run ${target} machine migrate`,
    )
  }
}

export async function prepareReleaseUpdate(input: {
  manifest: DistributionManifest
  requestedVersion?: string
  presentation: Presentation
}): Promise<ReleaseUpdatePreparation> {
  const targetName = releaseTarget(process.platform, process.arch)
  if (!targetName) {
    throw new Error(
      `unsupported release target ${process.platform}-${process.arch}; install on a supported platform`,
    )
  }
  const root = process.env[DOWNLOAD_BASE_URL_ENV] ?? DEFAULT_RELEASE_DOWNLOAD_ROOT
  const requested = input.requestedVersion
    ? normalizeReleaseVersion(input.requestedVersion)
    : undefined
  const releasePath = requested ? `download/v${requested}/` : 'latest/download/'
  const sumsUrl = releaseUrl(root, `${releasePath}SHA256SUMS`)
  const sums = new TextDecoder().decode(await readDownload(sumsUrl))
  const resolution = resolveReleaseVersion({
    sums,
    target: targetName,
    requestedVersion: input.requestedVersion,
    currentVersion: input.manifest.version,
    sumsUrl: sumsUrl.toString(),
  })
  if (resolution.action === 'current') return { action: 'current', message: resolution.message }

  const archiveUrl = releaseUrl(root, `${releasePath}${resolution.asset}`)
  const archive = await readDownload(archiveUrl)
  const received = createHash('sha256').update(archive).digest('hex')
  if (received !== resolution.digest) {
    throw new Error(digestMismatchRefusal(resolution.asset, resolution.digest, received))
  }

  const target = realpathSync(process.execPath)
  const directory = dirname(target)
  removeStaleStages(directory)
  const stage = mkdtempSync(join(directory, `.${PLATFORM_SLUG}-update.`))
  let retained = false
  try {
    const archivePath = join(stage, resolution.asset)
    writeFileSync(archivePath, archive)
    const unpack = Bun.spawnSync(['tar', '-xzf', archivePath, '-C', stage], {
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (unpack.exitCode !== 0) {
      throw new Error(`could not unpack ${resolution.asset}; retry the update`)
    }
    const staged = join(stage, PLATFORM_SLUG)
    if (!Bun.file(staged).size) {
      throw new Error(`${resolution.asset} does not contain ${PLATFORM_SLUG}; retry the update`)
    }
    chmodSync(staged, 0o755)
    let journal: MigrationJournalEntry[]
    try {
      journal = candidateJournal(staged)
    } catch {
      throw new Error(predatesUpdateRefusal(resolution.version))
    }
    const decision = candidateStoreDecision(appliedMigrations(), journal)
    if (decision.state === 'ahead') throw new Error(storeAheadRefusal(resolution.version))
    retained = true
    return {
      action: 'prepared',
      update: {
        decision,
        pendingMigration: journal[decision.position]?.tag ?? null,
        apply() {
          renameSync(staged, target)
          migrateInstalledBinary(target)
          input.presentation.log(`updated ${input.manifest.version} → ${resolution.version}`)
          const onPath = Bun.which(PLATFORM_SLUG)
          if (onPath && realpathSync(onPath) !== target) {
            input.presentation.log(
              `warning: ${PLATFORM_SLUG} on PATH resolves to ${onPath}, not updated target ${target}`,
            )
          }
        },
        cleanup() {
          rmSync(stage, { recursive: true, force: true })
        },
      },
    }
  } finally {
    if (!retained) rmSync(stage, { recursive: true, force: true })
  }
}
