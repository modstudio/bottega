import { accessSync, constants, statSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { assetPath } from '../../shared/install-root.ts'
import { type OrchProject, OrchProjectListSchema } from '../../shared/orch-contract.ts'
import {
  processObservationError,
  processObservationInterrupted,
} from '../../shared/process-identity.ts'
import { bottegaEntryArgv } from '../../shared/self-spawn.ts'
import type { ProjectListOptions } from './project-register-reader.ts'

export type { ProjectListOptions } from './project-register-reader.ts'

const PROJECT_LIST_TIMEOUT_MS = 20_000

/** Resolve the executable used to read the orchestrator project register. */
export function resolveOrchExecutable(): string {
  const override = process.env.BOTTEGA_ORCH?.trim() || null
  const checkout = assetPath('bin', PLATFORM_SLUG)
  if (override && usableExecutable(override)) return override
  if (usableExecutable(checkout)) return checkout
  const found = Bun.which(PLATFORM_SLUG, { PATH: process.env.PATH })
  if (found) return found
  throw missingBinary(override, checkout)
}

function usableExecutable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function missingBinary(override: string | null, checkout: string): Error {
  return new Error(
    `${PLATFORM_SLUG} executable unavailable: BOTTEGA_ORCH override ${override ?? 'unset'}; ` +
      `checkout executable ${checkout}; PATH lookup found nothing. ` +
      `Set BOTTEGA_ORCH to an executable file, restore the checkout executable, or add ${PLATFORM_SLUG} to PATH.`,
  )
}

export type ProjectListProcessResult = {
  command: string
  exitCode: number | null
  signalCode: string | number | null | undefined
  exitedDueToTimeout: boolean
  stderr: string
  stdout: string
  timeoutMs: number
}

/** Decide the project-register error without observing or spawning its process. */
export function projectListProcessError(result: ProjectListProcessResult): string | null {
  if (processObservationInterrupted(result)) {
    const classified = processObservationError(result.command, result.timeoutMs, result)
    return `${classified}; retry once the register responds`
  }
  if (result.exitCode === 0) return null
  return (
    result.stderr.trim() || result.stdout.trim() || `${result.command} exited ${result.exitCode}`
  )
}

export function projectList(options: ProjectListOptions = {}): OrchProject[] {
  const command = bottegaEntryArgv(PLATFORM_SLUG, resolveOrchExecutable)
  const args = ['project', 'list', ...(options.retired ? ['--retired'] : []), '--json']
  const proc = Bun.spawnSync([...command, ...args], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: PROJECT_LIST_TIMEOUT_MS,
  })
  const out = proc.stdout.toString()
  const error = projectListProcessError({
    command: `${PLATFORM_SLUG} ${args.join(' ')}`,
    exitCode: proc.exitCode,
    signalCode: proc.signalCode,
    exitedDueToTimeout: proc.exitedDueToTimeout === true,
    stderr: proc.stderr.toString(),
    stdout: out,
    timeoutMs: PROJECT_LIST_TIMEOUT_MS,
  })
  if (error) throw new Error(error)
  try {
    return OrchProjectListSchema.parse(JSON.parse(out))
  } catch (cause) {
    throw new Error(`invalid project register: ${String(cause)}`)
  }
}
