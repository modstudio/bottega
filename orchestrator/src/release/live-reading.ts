// concern: release-live-reading
/** Reads and parses the commit reported by a release rung's bounded live command. */

import { gitAt } from '../../../shared/git.ts'
import { gitBlobPrefix, targetGitEnvironment } from '../git/git-environment.ts'
import { releaseCapturedText, releaseProcessEnvironment } from './release-decision.ts'

export const RELEASE_LIVE_READING_TIMEOUT_MS = 15_000

export type LiveReadingCapture = {
  exitCode: number
  output: string
  timedOut: boolean
}

export type LiveReadingFailure = {
  ok: false
  kind: 'timeout' | 'nonzero-exit' | 'invalid-output' | 'unmapped-version'
  failure: string
}

export type LiveReading = { ok: true; commit: string } | LiveReadingFailure

export type LiveReadingRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => LiveReadingCapture

export type LiveVersionSettings = { command: string; file: string; key: string }

export type LiveVersionReading =
  | {
      ok: true
      commit: string
      version: string
      candidateVersion: string
      matchesCandidate: boolean
    }
  | LiveReadingFailure

const RELEASE_VERSION_FILE_BYTES = 1024 * 1024

function capturedText(text: string): string {
  return releaseCapturedText(text, /^[0-9a-f]{40}$/i.test(text) ? [text] : [])
}

/** Parse a captured live command without observing a process or clock. */
function parseLiveReading(capture: LiveReadingCapture): LiveReading {
  const failed = captureFailure(capture)
  if (failed) return failed
  const commit = capture.output.trim()
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    return {
      ok: false,
      kind: 'invalid-output',
      failure: `live command did not print one full commit sha: ${JSON.stringify(capturedText(commit))}`,
    }
  }
  return { ok: true, commit: commit.toLowerCase() }
}

function captureFailure(capture: LiveReadingCapture): LiveReadingFailure | null {
  if (capture.timedOut) return { ok: false, kind: 'timeout', failure: 'live reading timed out' }
  if (capture.exitCode === 0) return null
  const output = capturedText(capture.output.trim())
  return {
    ok: false,
    kind: 'nonzero-exit',
    failure: `live command failed (exit ${capture.exitCode}): ${output || '(no output)'}`,
  }
}

/** Read one string at a dot-separated path in a JSON document. */
export function jsonStringAtPath(source: string | null, key: string): string | null {
  if (source === null) return null
  try {
    let value: unknown = JSON.parse(source)
    for (const part of key.split('.')) {
      if (!value || typeof value !== 'object') return null
      value = (value as Record<string, unknown>)[part]
    }
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** Confirm that one commit, rather than a removal hit, introduces a version value. */
export function versionIntroducedAtCommit(facts: {
  current: string | null
  firstParent: string | null
  key: string
  version: string
}): boolean {
  return (
    jsonStringAtPath(facts.current, facts.key) === facts.version &&
    jsonStringAtPath(facts.firstParent, facts.key) !== facts.version
  )
}

/** Choose the newest confirmed introduction that belongs to the searched branch. */
export function newestVersionIntroduction(
  hits: readonly { commit: string; introduced: boolean; branchAncestor: boolean }[],
): string | null {
  return hits.find(({ introduced, branchAncestor }) => introduced && branchAncestor)?.commit ?? null
}

/** Version probes prove liveness by value equality, independently of commit ancestry. */
function liveVersionMatchesCandidate(served: string, candidate: string): boolean {
  return served === candidate
}

/** Give an unmapped served version the same failing shape as other live-reading failures. */
export function unmappedVersionFailure(
  version: string,
  file: string,
  branch: string,
): LiveReadingFailure {
  return {
    ok: false,
    kind: 'unmapped-version',
    failure: `served version ${version} is not introduced in ${file} on ${branch}`,
  }
}

function readVersionAtCommit(
  cwd: string,
  commit: string,
  settings: Pick<LiveVersionSettings, 'file' | 'key'>,
): string | null {
  return jsonStringAtPath(
    gitBlobPrefix(cwd, commit, settings.file, RELEASE_VERSION_FILE_BYTES),
    settings.key,
  )
}

export type VersionCommitReader = {
  log: (cwd: string, args: string[]) => { code: number; stdout: string }
  blob: (cwd: string, commit: string, file: string, maxBytes: number) => string | null
  isAncestor: (cwd: string, commit: string, branchRef: string) => boolean
}

const versionCommitReader: VersionCommitReader = {
  log: gitAt,
  blob: gitBlobPrefix,
  isAncestor: (cwd, commit, branchRef) =>
    gitAt(cwd, ['merge-base', '--is-ancestor', commit, branchRef]).code === 0,
}

export function mappedVersionCommit(
  cwd: string,
  branch: string,
  settings: Pick<LiveVersionSettings, 'file' | 'key'>,
  version: string,
  reader: VersionCommitReader = versionCommitReader,
): string | null {
  const branchRef = `origin/${branch}`
  const leafKey = settings.key.split('.').at(-1)!
  const literal = `${JSON.stringify(leafKey)}: ${JSON.stringify(version)}`
  const log = reader.log(cwd, [
    'log',
    '--format=%H',
    `-S${literal}`,
    branchRef,
    '--',
    settings.file,
  ])
  if (log.code !== 0) return null
  const commits = log.stdout.split(/\r?\n/).filter(Boolean)
  return newestVersionIntroduction(
    commits.map((commit) => ({
      commit,
      introduced: versionIntroducedAtCommit({
        current: reader.blob(cwd, commit, settings.file, RELEASE_VERSION_FILE_BYTES),
        firstParent: reader.blob(cwd, `${commit}^`, settings.file, RELEASE_VERSION_FILE_BYTES),
        key: settings.key,
        version,
      }),
      branchAncestor: reader.isAncestor(cwd, commit, branchRef),
    })),
  )
}

const runLiveCommand: LiveReadingRunner = (command, cwd, timeoutMs) => {
  const result = Bun.spawnSync(['/bin/sh', '-lc', command], {
    cwd,
    env: releaseProcessEnvironment(targetGitEnvironment(cwd)),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  })
  return {
    exitCode: result.exitCode ?? -1,
    output: [result.stdout.toString(), result.stderr.toString()].filter(Boolean).join(''),
    timedOut: result.exitedDueToTimeout === true,
  }
}

/** Run one live command with the shared bound and parse its captured result. */
export function readLiveCommit(
  command: string,
  cwd: string,
  runner: LiveReadingRunner = runLiveCommand,
): LiveReading {
  return parseLiveReading(runner(command, cwd, RELEASE_LIVE_READING_TIMEOUT_MS))
}

/** Read the served version, candidate value, and ledger commit for one version probe. */
export function readLiveVersion(
  settings: LiveVersionSettings,
  cwd: string,
  candidate: string,
  branch: string,
  runner: LiveReadingRunner = runLiveCommand,
): LiveVersionReading {
  const capture = runner(settings.command, cwd, RELEASE_LIVE_READING_TIMEOUT_MS)
  const failed = captureFailure(capture)
  if (failed) return failed
  const version = capture.output.trim()
  if (!version || /\r|\n/.test(version)) {
    return {
      ok: false,
      kind: 'invalid-output',
      failure: `live command did not print exactly one non-empty version line: ${JSON.stringify(capturedText(version))}`,
    }
  }
  const candidateVersion = readVersionAtCommit(cwd, candidate, settings)
  if (candidateVersion === null) {
    return {
      ok: false,
      kind: 'invalid-output',
      failure: `candidate version is missing or not a string at ${settings.file}:${settings.key}`,
    }
  }
  if (liveVersionMatchesCandidate(version, candidateVersion)) {
    return {
      ok: true,
      commit: candidate,
      version,
      candidateVersion,
      matchesCandidate: true,
    }
  }
  const commit = mappedVersionCommit(cwd, branch, settings, version)
  if (commit === null) return unmappedVersionFailure(version, settings.file, branch)
  return {
    ok: true,
    commit,
    version,
    candidateVersion,
    matchesCandidate: false,
  }
}
