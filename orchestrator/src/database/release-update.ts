// concern: installed release update adapter
/** Downloads, verifies, probes, stages, swaps, and migrates one installed release. */

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
  releaseChannelPath,
  releaseTarget,
} from '../../../shared/release-artifacts.ts'
import {
  DATABASE_HUB_ENV,
  ORCHESTRATOR_DATABASE_ENV,
  ORCHESTRATOR_DATABASE_WRITE_ENV,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'
import { MACHINE_JOURNAL_SCHEMA, MACHINE_JOURNAL_SCHEMA_VERSION } from '../machine-journal.ts'
import { withSynchronousDatabaseForMigrationStep } from './db.ts'
import {
  type CandidateMigration,
  type CandidateStoreDecision,
  candidateStoreDecision,
  downloadBaseUrlRefusal,
  predatesUpdateRefusal,
  resolveReleaseVersion,
  storeAheadRefusal,
  unreadableJournalSchemaRefusal,
  unsupportedTargetRefusal,
  verifyArchiveDigest,
} from './release-update-decision.ts'

type Presentation = { log(value: string): void }

type PreparedReleaseUpdate = {
  decision: Extract<CandidateStoreDecision, { state: 'positioned' }>
  pendingMigration: string | null
  apply(): void
  cleanup(): void
}

export type ReleaseUpdatePreparation =
  | { action: 'current'; version: string }
  | { action: 'prepared'; update: PreparedReleaseUpdate }

function releaseUrl(root: URL, path: string): URL {
  return new URL(path, `${root.toString().replace(/\/+$/, '')}/`)
}

async function readDownload(url: URL): Promise<Uint8Array> {
  const schemeRefusal = downloadBaseUrlRefusal(url.toString())
  if (schemeRefusal) throw new Error(schemeRefusal)
  if (url.protocol === 'file:') return readFileSync(fileURLToPath(url))
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

const RELEASE_UPDATE_DATABASE_OVERRIDE_ENVS = [
  ORCHESTRATOR_DATABASE_ENV,
  ORCHESTRATOR_DATABASE_WRITE_ENV,
  DATABASE_HUB_ENV,
] as const

function databaseOverrideFreeEnvironment(
  additions: Record<string, string> = {},
): Record<string, string | undefined> {
  const env = { ...process.env, ...additions }
  for (const name of RELEASE_UPDATE_DATABASE_OVERRIDE_ENVS) delete env[name]
  return env
}

function candidateJournal(staged: string, version: string): CandidateMigration[] {
  const state = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-update-probe.`))
  try {
    const result = Bun.spawnSync([staged, 'machine', 'journal', '--json'], {
      env: databaseOverrideFreeEnvironment({ [STATE_HOME_ENV]: state }),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = result.stderr.toString()
    if (result.exitCode !== 0) {
      throw new Error(predatesUpdateRefusal(version, result.exitCode, stderr))
    }
    let output: unknown
    try {
      output = JSON.parse(result.stdout.toString())
    } catch {
      throw new Error(predatesUpdateRefusal(version, result.exitCode, stderr))
    }
    if (
      typeof output !== 'object' ||
      output === null ||
      (output as { schemaVersion?: unknown }).schemaVersion !== MACHINE_JOURNAL_SCHEMA_VERSION
    ) {
      throw new Error(unreadableJournalSchemaRefusal(version, result.exitCode, stderr))
    }
    let parsed: ReturnType<typeof MACHINE_JOURNAL_SCHEMA.parse>
    try {
      parsed = MACHINE_JOURNAL_SCHEMA.parse(output)
    } catch {
      throw new Error(predatesUpdateRefusal(version, result.exitCode, stderr))
    }
    return parsed.orchestratorJournal.map((entry) => ({
      ...entry,
      compatibility: entry.compatibility ?? undefined,
    }))
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
}

function appliedMigrations(): { when: number; hash: string }[] {
  return withSynchronousDatabaseForMigrationStep((database) => {
    const table = database
      .query<{ present: number }, []>(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='orch_migrations'",
      )
      .get()
    if (!table) return []
    return database
      .query<{ created_at: number; hash: string }, []>(
        'SELECT created_at,hash FROM orch_migrations ORDER BY id',
      )
      .all()
      .map((row) => ({ when: Number(row.created_at), hash: row.hash }))
  })
}

export function migrateInstalledBinary(target: string): void {
  const result = Bun.spawnSync([target, 'machine', 'migrate'], {
    env: databaseOverrideFreeEnvironment(),
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
  if (!targetName) throw new Error(unsupportedTargetRefusal(process.platform, process.arch))
  const rootValue = process.env[DOWNLOAD_BASE_URL_ENV] ?? DEFAULT_RELEASE_DOWNLOAD_ROOT
  const rootRefusal = downloadBaseUrlRefusal(rootValue)
  if (rootRefusal) throw new Error(rootRefusal)
  const root = new URL(rootValue)
  const releasePath = releaseChannelPath(input.requestedVersion)
  const sumsUrl = releaseUrl(root, `${releasePath}SHA256SUMS`)
  const sums = new TextDecoder().decode(await readDownload(sumsUrl))
  const resolution = resolveReleaseVersion({
    sums,
    target: targetName,
    requestedVersion: input.requestedVersion,
    currentVersion: input.manifest.version,
    sumsUrl: sumsUrl.toString(),
  })
  if (resolution.action === 'current') return resolution

  const archiveUrl = releaseUrl(root, `${releasePath}${resolution.asset}`)
  const archive = await readDownload(archiveUrl)
  const digestRefusal = verifyArchiveDigest(archive, resolution)
  if (digestRefusal) throw new Error(digestRefusal)

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
    const journal = candidateJournal(staged, resolution.version)
    const decision = candidateStoreDecision(appliedMigrations(), journal)
    if (decision.state === 'ahead') {
      throw new Error(storeAheadRefusal(resolution.version, input.manifest.version))
    }
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
