// concern: release-live-reading
/** Reads and parses the commit reported by a release rung's bounded live command. */

import { targetGitEnvironment } from '../git/git-environment.ts'
import { releaseCapturedText, releaseProcessEnvironment } from './release-decision.ts'

export const RELEASE_LIVE_READING_TIMEOUT_MS = 15_000

export type LiveReadingCapture = {
  exitCode: number
  output: string
  timedOut: boolean
}

export type LiveReadingFailure = {
  ok: false
  kind: 'timeout' | 'nonzero-exit' | 'invalid-output'
  failure: string
}

export type LiveReading = { ok: true; commit: string } | LiveReadingFailure

export type LiveReadingRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => LiveReadingCapture

function capturedText(text: string): string {
  return releaseCapturedText(text, /^[0-9a-f]{40}$/i.test(text) ? [text] : [])
}

/** Parse a captured live command without observing a process or clock. */
function parseLiveReading(capture: LiveReadingCapture): LiveReading {
  if (capture.timedOut) {
    return { ok: false, kind: 'timeout', failure: 'live reading timed out' }
  }
  if (capture.exitCode !== 0) {
    const output = capturedText(capture.output.trim())
    return {
      ok: false,
      kind: 'nonzero-exit',
      failure: `live command failed (exit ${capture.exitCode}): ${output || '(no output)'}`,
    }
  }
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
