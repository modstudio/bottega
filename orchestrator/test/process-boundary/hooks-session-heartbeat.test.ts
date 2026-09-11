import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, chmodSync, copyFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { MONITOR_CAPABILITY_PATH_ENV, MONITOR_CAPABILITY_TOKEN_ENV } from '../../../shared/monitor-capability.ts'
import { addRun, allInjectChecks, claimMonitorNotices, markMonitorNoticesDelivered, db, deadRunningProcessConditions, dir, displayConditions, fileIssue, formatMonitorPass, hermeticGitEnv, monitor, monitorHistory, nowIso, parseFiledIssue, reconcileHub, rulingConditions, runWithDelayedStdoutReader, score, setDoc, upsertProject } from '../fixture.ts'

  const hook = new URL('../../hooks/session-brief.py', import.meta.url).pathname
  const heartbeat = new URL('../../hooks/orch-heartbeat.sh', import.meta.url).pathname
  const bypassOversizeWriteGate = () => {
    const doc = setDoc({
      scope: 'global', subject: null, slug: 'oversize', title: 'Oversize',
      body: 'x'.repeat(70 * 1024), delivery: 'demand',
    })
    db().query("UPDATE doc SET delivery='inject' WHERE id=?").run(doc.id)
  }
  const runBrief = (
    payload: object,
    extraEnv: Record<string, string> = {},
    colour: 'plain' | 'ansi' = 'plain',
  ) => {
    const {
      CLAUDE_CODE_SESSION_ID: _drop,
      FORCE_COLOR: _forceColor,
      NO_COLOR: _noColor,
      ...rest
    } = process.env
    const colourEnv = colour === 'ansi' ? { FORCE_COLOR: '1' } : { NO_COLOR: '1' }
    return Bun.spawnSync(
      [hook],
      {
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: 'pipe', stderr: 'pipe',
        env: { ...rest, ORCH_DB: process.env.ORCH_DB!, ...extraEnv, ...colourEnv },
      },
    )
  }
  const hookOutput = (p: ReturnType<typeof runBrief>) => JSON.parse(p.stdout.toString()) as {
    hookSpecificOutput: { hookEventName: string, additionalContext: string }
    systemMessage?: string
  }
  const resumeBody = (status: string, written: string) =>
    `---\nstatus: ${status}\nepic: demo\nproject: known\nwritten: ${written}\n---\n\nSECRET BODY\nNEXT ACTION\n`
  const runCopiedBrief = (opts: { payload: object, heartbeat: 'missing' | 'non-executable' }) => {
    const root = mkdtempSync(join(tmpdir(), 'session-brief-heartbeat-'))
    const hooksDir = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    copyFileSync(hook, join(hooksDir, 'session-brief.py'))
    writeFileSync(
      join(root, 'bin', 'orch'),
      '#!/bin/sh\n' +
      'if [ "$1" = "inbox" ]; then echo "[]"; exit 0; fi\n' +
      'if [ "$1" = "monitor" ]; then echo "[]"; exit 0; fi\n' +
      'if [ "$1" = "doc" ] && [ "$2" = "resumes" ]; then echo \'{"open":[],"unreadable":[]}\'; exit 0; fi\n' +
      'if [ "$1" = "doc" ] && [ "$2" = "brief" ]; then exit 0; fi\n' +
      'exit 1\n',
    )
    chmodSync(join(root, 'bin', 'orch'), 0o755)
    const copiedHeartbeat = join(hooksDir, 'orch-heartbeat.sh')
    if (opts.heartbeat === 'non-executable') {
      writeFileSync(copiedHeartbeat, '#!/bin/sh\nexit 0\n')
      chmodSync(copiedHeartbeat, 0o644)
    }
    const { CLAUDE_CODE_SESSION_ID: _drop, ...rest } = process.env
    const p = Bun.spawnSync(['python3', join(hooksDir, 'session-brief.py')], {
      stdin: new TextEncoder().encode(JSON.stringify(opts.payload)),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...rest, ORCH_DB: process.env.ORCH_DB! },
    })
    return { p, heartbeat: copiedHeartbeat, root }
  }


describe('session-brief heartbeat process boundary', () => {
  test('missing heartbeat is a notice on both channels, not a block', () => {
    const { p, heartbeat: missingPath, root } = runCopiedBrief({
      payload: { cwd: '/w/known', source: 'startup', session_id: 'sid-missing' },
      heartbeat: 'missing',
    })
    try {
      expect(p.exitCode).toBe(0)
      const out = hookOutput(p)
      const msg = `Heartbeat missing or not executable: ${missingPath}`
      expect(out.hookSpecificOutput.additionalContext).toBe(msg + '\n')
      expect(out.systemMessage).toBe(msg)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('non-executable heartbeat is a notice on both channels, not a block', () => {
    const { p, heartbeat: blockedPath, root } = runCopiedBrief({
      payload: { cwd: '/w/known', source: 'startup', session_id: 'sid-nox' },
      heartbeat: 'non-executable',
    })
    try {
      expect(p.exitCode).toBe(0)
      const out = hookOutput(p)
      const msg = `Heartbeat missing or not executable: ${blockedPath}`
      expect(out.hookSpecificOutput.additionalContext).toBe(msg + '\n')
      expect(out.systemMessage).toBe(msg)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('missing heartbeat still notices when session id is absent', () => {
    const { p, heartbeat: missingPath, root } = runCopiedBrief({
      payload: { cwd: '/w/known', source: 'startup' },
      heartbeat: 'missing',
    })
    try {
      expect(p.exitCode).toBe(0)
      const out = hookOutput(p)
      const msg = `Heartbeat missing or not executable: ${missingPath}`
      expect(out.hookSpecificOutput.additionalContext).toBe(msg + '\n')
      expect(out.systemMessage).toBe(msg)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
