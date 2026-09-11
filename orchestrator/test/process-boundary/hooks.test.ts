import { describe,expect,test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('hooks fail open visibly', () => {
const runHook = (name: string, input: string) => Bun.spawnSync(
    ['python3', new URL(`../../hooks/${name}`, import.meta.url).pathname],
    { stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! } },
  )
test('malformed stdin exits zero and writes one stderr line', () => {
    for (const hook of ['block-agent.py', 'score-reminder.py']) {
      const p = runHook(hook, '{not json')
      expect(p.exitCode).toBe(0)
      const lines = p.stderr.toString().trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('payload could not be parsed')
    }
    const fallback = new URL('../../spawn-fallback.log', import.meta.url).pathname
    expect(readFileSync(fallback, 'utf8').trim().split('\n').at(-1))
      .toContain('payload could not be parsed')
  })
test('NEEDS-WEB deep in a prompt is not a declaration', () => {
    const prompt = 'x'.repeat(500) + ' NEEDS-WEB'
    const p = runHook('block-agent.py', JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Agent',
      tool_input: { description: 'read files', prompt, subagent_type: 'general-purpose' },
    }))
    expect(p.exitCode).toBe(0)
    const reply = JSON.parse(p.stdout.toString())
    expect(reply.hookSpecificOutput.permissionDecision).toBe('deny')
  })
})
