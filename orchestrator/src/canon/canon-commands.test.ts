import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAgent, refreshAgents, removeAgent } from '../agent/agent-registry.ts'
import { dispatchCanonCommand } from './canon-commands.ts'

test('worker load measurement resolves a registered agent name to its harness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-load-command-'))
  const home = join(root, 'home')
  const priorHome = process.env.HOME
  try {
    Bun.spawnSync(['git', 'init'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Architect instructions.')
    writeFileSync(join(root, 'CLAUDE.md'), 'Project instructions.')
    addAgent('grok-variant', { harness: 'grok', backend: 'vendor', model: 'grok-variant' })
    refreshAgents()
    process.env.HOME = home

    const output: string[] = []
    const values = new Map([
      ['cwd', root],
      ['harness', 'grok'],
      ['role', 'worker'],
      ['agent', 'grok-variant'],
    ])
    await dispatchCanonCommand(
      ['canon', 'load'],
      {
        has: (name) => values.has(name),
        flag: (name) => values.get(name),
      },
      {
        log: (...parts) => output.push(parts.join(' ')),
        exitCode: () => {},
        cwd: () => root,
      },
    )

    expect(output.join('\n')).toContain(`${root}/CLAUDE.md`)
    expect(output.join('\n')).not.toContain(`${home}/.claude/CLAUDE.md`)
  } finally {
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    removeAgent('grok-variant')
    refreshAgents()
    rmSync(root, { recursive: true, force: true })
  }
})
