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
  const runWithResumePayload = (resumePayload: string) => {
    const root = mkdtempSync(join(tmpdir(), 'session-brief-resume-payload-'))
    const hooksDir = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    copyFileSync(hook, join(hooksDir, 'session-brief.py'))
    const fakeOrch = join(root, 'bin', 'orch')
    writeFileSync(
      fakeOrch,
      `#!/bin/sh
if [ "$1" = "doc" ] && [ "$2" = "brief" ]; then echo "OPERATOR BRIEF"; exit 0; fi
if [ "$1" = "doc" ] && [ "$2" = "resumes" ]; then printf '%s\\n' '${resumePayload}'; exit 0; fi
if [ "$1" = "inbox" ]; then echo '[{"session_liveness":"live","can_answer":true}]'; exit 0; fi
if [ "$1" = "monitor" ]; then echo '[]'; exit 0; fi
exit 1
`,
    )
    chmodSync(fakeOrch, 0o755)
    try {
      const p = Bun.spawnSync(['python3', join(hooksDir, 'session-brief.py')], {
        stdin: new TextEncoder().encode(JSON.stringify({
          cwd: '/w/known', source: 'compact', session_id: 'reader',
        })),
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      return { process: p, output: hookOutput(p) }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const runWithResumeCommand = (resumeCommand: string) => {
    const root = mkdtempSync(join(tmpdir(), 'session-brief-resume-command-'))
    const hooksDir = join(root, 'orchestrator', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    copyFileSync(hook, join(hooksDir, 'session-brief.py'))
    const fakeOrch = join(root, 'bin', 'orch')
    writeFileSync(
      fakeOrch,
      `#!/bin/sh
if [ "$1" = "doc" ] && [ "$2" = "brief" ]; then echo "OPERATOR BRIEF"; exit 0; fi
if [ "$1" = "doc" ] && [ "$2" = "resumes" ]; then ${resumeCommand}; fi
if [ "$1" = "inbox" ]; then echo '[{"session_liveness":"live","can_answer":true}]'; exit 0; fi
if [ "$1" = "monitor" ]; then echo '[]'; exit 0; fi
exit 1
`,
    )
    chmodSync(fakeOrch, 0o755)
    try {
      const p = Bun.spawnSync(['python3', join(hooksDir, 'session-brief.py')], {
        stdin: new TextEncoder().encode(JSON.stringify({
          cwd: '/w/known', source: 'compact', session_id: 'reader',
        })),
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      })
      return { process: p, output: hookOutput(p) }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }


describe('session-brief hook process boundary', () => {
  test('reports unreadable resume briefs without offering them as resumable', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'unreadable', title: 'Unreadable',
      body: resumeBody('open', '2026-09-03T00:00:00.000Z'),
    })
    db().query('UPDATE doc SET body=? WHERE scope=? AND subject=? AND slug=?')
      .run('BODY without frontmatter', 'resume', 'known', 'unreadable')

    const result = runBrief({ cwd: '/w/known', source: 'clear' })
    expect(result.exitCode).toBe(0)
    const output = hookOutput(result)
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'UNREADABLE RESUME BRIEF `unreadable`: no-frontmatter.',
    )
    expect(output.hookSpecificOutput.additionalContext).not.toContain('Offer to resume')
    expect(output.systemMessage).toContain('Unreadable resume brief: `unreadable`.')
    expect(output.systemMessage).not.toContain('Open resume brief')
  })

  test('accepts an unrecognised-status unreadable item and still emits the other hook sections', () => {
    const { process: p, output } = runWithResumePayload(
      '{"open":[],"unreadable":[{"slug":"pending-brief","reason":"unrecognised-status"}]}',
    )
    expect(p.exitCode).toBe(0)
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'UNREADABLE RESUME BRIEF `pending-brief`: unrecognised-status.',
    )
    expect(output.systemMessage).toContain('Unreadable resume brief: `pending-brief`.')
    expect(output.systemMessage).toContain('1 question waiting on your ruling.')
    expect(output.systemMessage).not.toContain('Resume response was invalid')
    expect(output.systemMessage).not.toContain('Open resume brief')
  })

  test('malformed stdin exits zero and prints nothing', () => {
    const p = Bun.spawnSync(['python3', hook], {
      stdin: new TextEncoder().encode('{not json'),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! },
    })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toBe('')
  })

  test('rejects a whitespace-containing resume slug without blanking other hook output', () => {
    const { process: p, output } = runWithResumePayload(
      '{"open":[{"slug":"hello world","title":"T","age":"1d"}],"unreadable":[]}',
    )
    expect(p.exitCode).toBe(0)
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.systemMessage).toContain('1 question waiting on your ruling.')
    expect(output.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
    expect(output.systemMessage).not.toContain('`hello`')
  })

  test('rejects an all-whitespace resume slug instead of treating its title as the slug', () => {
    const { output } = runWithResumePayload(
      '{"open":[{"slug":"   ","title":"forged-brief","age":"1d"}],"unreadable":[]}',
    )
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
    expect(output.systemMessage).not.toContain('`forged-brief`')
  })

  test('rejects an empty resume slug without blanking operator and inbox output', () => {
    const { process: p, output } = runWithResumePayload(
      '{"open":[{"slug":"","title":"","age":""}],"unreadable":[]}',
    )
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).not.toBe('')
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.systemMessage).toContain('1 question waiting on your ruling.')
    expect(output.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
  })

  test('enforces the document slug contract on resume payloads', () => {
    const outside = runWithResumePayload(
      '{"open":[{"slug":"../outside","title":"T","age":"1d"}],"unreadable":[]}',
    ).output
    expect(outside.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
    expect(outside.systemMessage).not.toContain('`../outside`')

    const valid = runWithResumePayload(
      '{"open":[{"slug":"a-valid-slug","title":"T","age":"1d"}],"unreadable":[]}',
    ).output
    expect(valid.systemMessage).toContain('Open resume brief: `a-valid-slug`.')
    expect(valid.systemMessage).not.toContain('Resume response was invalid')

    const tooLong = 'a'.repeat(65)
    const overLimit = runWithResumePayload(JSON.stringify({
      open: [{ slug: tooLong, title: 'T', age: '1d' }], unreadable: [],
    })).output
    expect(overLimit.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
    expect(overLimit.systemMessage).not.toContain(`\`${tooLong}\``)
  })

  test('a failed resume command is visible without blanking operator and inbox output', () => {
    const { process: p, output } = runWithResumeCommand(
      'echo "first failure" >&2; echo "second failure" >&2; exit 7',
    )
    expect(p.exitCode).toBe(0)
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.systemMessage).toContain(
      'Resume command failed with exit 7: first failure; brief state is unknown.',
    )
    expect(output.systemMessage).toContain('1 question waiting on your ruling.')
  })

  test('a resume timeout is visible without blanking operator and inbox output', () => {
    const { process: p, output } = runWithResumeCommand('exec sleep 20')
    expect(p.exitCode).toBe(0)
    expect(output.hookSpecificOutput.additionalContext).toContain('OPERATOR BRIEF')
    expect(output.systemMessage).toContain(
      'Resume observation timed out; brief state is unknown.',
    )
    expect(output.systemMessage).toContain('1 question waiting on your ruling.')
  }, 15_000)

  for (const [name, payload] of [
    ['null unreadable', '{"open":[{"slug":"epic-name","title":"Title","age":"1d"}],"unreadable":null}'],
    ['missing unreadable', '{"open":[{"slug":"epic-name","title":"Title","age":"1d"}]}'],
    ['invalid unreadable item', '{"open":[{"slug":"epic-name","title":"Title","age":"1d"}],"unreadable":[{"slug":"x","reason":"unknown"}]}'],
  ]) {
    test(`keeps a valid open brief and reports ${name}`, () => {
      const { output } = runWithResumePayload(payload)
      expect(output.hookSpecificOutput.additionalContext).toContain(
        'Open resume brief `epic-name`.',
      )
      expect(output.systemMessage).toContain('Open resume brief: `epic-name`.')
      expect(output.systemMessage).toContain('Resume response was invalid; brief state is unknown.')
    })
  }

  test('one open brief: cold start asks, continuation offers, never dumps the body', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'epic-name', title: 'Title here',
      body: resumeBody('open', '2026-09-03T00:00:00.000Z'),
    })
    const listLine = `${'epic-name'.padEnd(24)} ${'Title here'.padEnd(24)}`
    const cold = runBrief({ cwd: '/w/known', source: 'startup' })
    expect(cold.exitCode).toBe(0)
    const coldOutput = hookOutput(cold)
    expect(coldOutput.hookSpecificOutput.hookEventName).toBe('SessionStart')
    const coldOut = coldOutput.hookSpecificOutput.additionalContext
    expect(coldOut).toContain(listLine)
    expect(coldOut).toContain(
      'Open resume brief `epic-name`. Ask whether to load it before fetching with get_doc; after they agree and it is loaded, run orch doc consume.',
    )
    expect(coldOut).not.toContain('SECRET BODY')
    expect(coldOutput.systemMessage).toBe('Open resume brief: `epic-name`.')
    const cont = runBrief({ cwd: '/w/known', source: 'clear' })
    expect(hookOutput(cont).hookSpecificOutput.additionalContext).toContain(
      'Open resume brief `epic-name`. Offer to resume from it; fetch with get_doc only after they agree, then run orch doc consume.',
    )
    const resumeSrc = runBrief({ cwd: '/w/known', source: 'resume' })
    expect(hookOutput(resumeSrc).hookSpecificOutput.additionalContext).toContain('Ask whether to load it')
    const fork = runBrief({ cwd: '/w/known', source: 'fork' })
    expect(hookOutput(fork).hookSpecificOutput.additionalContext).toContain('Offer to resume from it')
  })

  test('several open briefs use the plural sentence', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'one', title: 'First',
      body: resumeBody('open', '2026-09-03T01:00:00.000Z'),
    })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'two', title: 'Second',
      body: resumeBody('open', '2026-09-03T02:00:00.000Z'),
    })
    const cold = runBrief({ cwd: '/w/known', source: 'startup' })
    const coldOutput = hookOutput(cold)
    expect(coldOutput.hookSpecificOutput.additionalContext).toContain(
      'Open resume briefs above. Ask which (if any) to load before fetching with get_doc; after they agree and one is loaded, run orch doc consume.',
    )
    expect(coldOutput.systemMessage).toBe('Open resume briefs: `two`, `one`.')
    const cont = runBrief({ cwd: '/w/known', source: 'compact' })
    expect(hookOutput(cont).hookSpecificOutput.additionalContext).toContain(
      'Open resume briefs above. Offer to resume from one of them; fetch with get_doc only after they agree, then run orch doc consume.',
    )
  })

  test('keeps the operator brief and appends resumes after it', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'g', title: 'Global', body: 'G' })
    setDoc({
      scope: 'resume', subject: 'known', slug: 'epic-name', title: 'Title here',
      body: resumeBody('open', '2026-09-03T00:00:00.000Z'),
    })
    const p = runBrief({ cwd: '/w/known', source: 'startup' })
    const out = hookOutput(p).hookSpecificOutput.additionalContext
    expect(out).toContain('## Global\n\nG')
    expect(out.indexOf('## Global')).toBeLessThan(out.indexOf('epic-name'))
    expect(out).toContain('Ask whether to load it')
  })

  test('startup with the script present and no session id prints nothing', () => {
    const p = runBrief({ cwd: '/w/known', source: 'startup' })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toBe('')
    expect(p.stderr.toString()).toBe('')
  })

  test('payload session_id wins over CLAUDE_CODE_SESSION_ID', () => {
    const p = runBrief(
      { cwd: '/w/known', source: 'startup', session_id: 'from-payload' },
      { CLAUDE_CODE_SESSION_ID: 'from-env' },
    )
    expect(hookOutput(p).hookSpecificOutput.additionalContext).toBe(
      `Arm under Monitor from the main checkout: ${heartbeat} from-payload\n`,
    )
  })

  test('falls back to CLAUDE_CODE_SESSION_ID when the payload has no session_id', () => {
    const p = runBrief(
      { cwd: '/w/known', source: 'startup' },
      { CLAUDE_CODE_SESSION_ID: 'from-env' },
    )
    expect(hookOutput(p).hookSpecificOutput.additionalContext).toBe(
      `Arm under Monitor from the main checkout: ${heartbeat} from-env\n`,
    )
  })

})
