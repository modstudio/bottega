import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, db, dir, hermeticGitEnv, reviewReply, runJob, upsertProject } from '../test/fixture.ts'
import {
  mcpCallEvidence, mcpEndpointAllowlist, namesSeenAt, parseMcpConfig, parseMcpProbe, probeMcpServer, storedMcpProbe,
  wrongProjectReason,
} from './mcp-probe.ts'
import { readonlyLensProfile } from './sandbox.ts'

const fixtureProject = {
  id: 1, name: 'fixture', path: '/projects/fixture', stack: 'node', canon: true, settings: {},
}

function writeMintedStdioServer(dir: string): string {
  const server = join(dir, 'minted-mcp-server.ts')
  writeFileSync(server, `
let buf = Buffer.alloc(0)
const reply = (id: number, result: unknown) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }))
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n')
  process.stdout.write(body)
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (true) {
    const text = buf.toString('utf8')
    const match = /^Content-Length:\\s*(\\d+)\\r\\n\\r\\n/.exec(text)
    if (!match) return
    const offset = match[0].length
    const length = Number(match[1])
    if (buf.length < offset + length) return
    const message = JSON.parse(buf.subarray(offset, offset + length).toString('utf8'))
    buf = buf.subarray(offset + length)
    if (message.method === 'initialize') reply(message.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'minted' } })
    else if (message.method === 'tools/list') reply(message.id, { tools: [{ name: 'ping' }] })
    else if (message.method === 'tools/call') reply(message.id, { content: [{ type: 'text', text: 'pong' }] })
  }
})
`)
  return server
}

describe('MCP endpoint allowlist', () => {
  test('adds host and host:port from the registered server URL and nothing else', () => {
    expect(mcpEndpointAllowlist('https://mcp.example.test:8443/sse')).toEqual([
      'mcp.example.test', 'mcp.example.test:8443',
    ])
    const profile = readonlyLensProfile({
      worktree: '/runs/tree', runsDir: '/runs/evidence', project: fixtureProject,
      agent: 'grok', path: '/usr/bin', nodeModuleLinks: [],
      mcpEndpoint: 'https://mcp.example.test:8443/sse',
    })
    expect(profile.network.allowedDomains).toContain('mcp.example.test')
    expect(profile.network.allowedDomains).toContain('mcp.example.test:8443')
    const without = readonlyLensProfile({
      worktree: '/runs/tree', runsDir: '/runs/evidence', project: fixtureProject,
      agent: 'grok', path: '/usr/bin', nodeModuleLinks: [],
    })
    expect(without.network.allowedDomains).not.toContain('mcp.example.test')
  })
})

describe('wrong-project refusal', () => {
  test('names the extra servers and ignores orch-ask', () => {
    expect(wrongProjectReason('starship', ['starship', 'orch-ask'])).toBeNull()
    // bottega's tracked .mcp.json lists every project's server beside the required one
    expect(wrongProjectReason('starship', ['starship', 'stopal', 'alephbeis', 'orch-ask'])).toBeNull()
    expect(wrongProjectReason('starship', ['alephbeis', 'orch-ask']))
      .toBe('wrong project: saw alephbeis and not starship')
    expect(wrongProjectReason('starship', ['orch-ask'])).toBeNull()
    expect(wrongProjectReason('orch', [
      'starship', 'stopal', 'alephbeis', 'youtrack-starship', 'youtrack-alephbeis',
    ])).toBeNull()
  })

  test('an absent config has no wrong-project evidence', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orch-mcp-no-config-'))
    try {
      expect(wrongProjectReason('fixture-project', namesSeenAt(cwd))).toBeNull()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('in-confinement probe', () => {
  test('namesSeen is the parsed config keys plus allowed extras', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-mcp-names-'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'fixture-project': { url: 'http://127.0.0.1:1/mcp' },
        alephbeis: { url: 'http://127.0.0.1:1/alephbeis' },
      },
    }))
    const result = await probeMcpServer({
      server: 'fixture-project',
      config: { name: 'fixture-project', url: 'http://127.0.0.1:1/mcp' },
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
    })
    expect(result.namesSeen.sort()).toEqual(['alephbeis', 'fixture-project', 'orch', 'orch-ask'])
    rmSync(dir, { recursive: true, force: true })
  })

  test('lists tools on a minted stdio server and calls the named probe tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-mcp-probe-'))
    const server = writeMintedStdioServer(dir)
    const result = await probeMcpServer({
      server: 'fixture-project',
      config: { name: 'fixture-project', command: process.execPath, args: [server] },
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      probeTool: 'ping',
    })
    expect(result.ok).toBe(true)
    expect(result.tool).toBe('ping')
    expect(result.detail).toContain('listed: 1 tools')
    const stored = parseMcpProbe(storedMcpProbe(result))
    expect(stored?.ok).toBe(true)
    expect(stored?.server).toBe('fixture-project')
    expect(stored?.durationMs).toBe(result.durationMs)
    expect(stored?.namesSeen).toEqual(result.namesSeen)
    expect(mcpCallEvidence(stored)).toEqual({
      connected: 1, error: 'verified: successful tool call ping',
    })
    rmSync(dir, { recursive: true, force: true })
  })

  test('a handshake without a tool call is unverified and an error is disconnected', () => {
    const handshake = {
      server: 'fixture-project', tool: 'tools/list', ok: true, error: null,
      durationMs: 1, detail: 'listed: 1 tools', namesSeen: ['fixture-project'],
    }
    expect(mcpCallEvidence(handshake)).toEqual({
      connected: null, error: 'unverified: no tool call observed',
    })
    expect(mcpCallEvidence({ ...handshake, ok: false, error: 'HTTP 403' })).toEqual({
      connected: 0, error: 'HTTP 403',
    })
  })

  test('records err when the HTTP endpoint is unreachable', async () => {
    const result = await probeMcpServer({
      server: 'fixture-project',
      config: { name: 'fixture-project', url: 'http://127.0.0.1:1/mcp' },
      cwd: tmpdir(),
      env: { ...process.env } as Record<string, string>,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(parseMcpProbe(storedMcpProbe(result))?.ok).toBe(false)
  })

  test('HTTP tools/list succeeds against a local stand-in and wrap can refuse it', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = await request.json() as { id: number; method: string }
        if (body.method === 'initialize') {
          return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'http' } } })
        }
        if (body.method === 'tools/list') {
          return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'ping' }] } })
        }
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { message: 'unknown' } }, { status: 400 })
      },
    })
    const reachable = await probeMcpServer({
      server: 'fixture-project',
      config: { name: 'fixture-project', url: `http://127.0.0.1:${server.port}/mcp` },
      cwd: tmpdir(),
      env: { ...process.env } as Record<string, string>,
    })
    expect(reachable.ok).toBe(true)
    expect(reachable.detail).toBe('listed: 1 tools')
    const refused = await probeMcpServer({
      server: 'fixture-project',
      config: { name: 'fixture-project', url: `http://127.0.0.1:${server.port}/mcp` },
      cwd: tmpdir(),
      env: { ...process.env } as Record<string, string>,
      wrap: () => ['false'],
    })
    expect(refused.ok).toBe(false)
    server.stop()
  })
})

describe('strict probe refuses before the agent starts', () => {
  test('require with an unreachable in-confinement server records the probe and starts no agent', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-mcp-strict-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git('add', 'tracked.txt')
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({
      mcpServers: { 'fixture-project': { url: 'http://127.0.0.1:1/mcp' } },
    }))
    git('add', '.mcp.json')
    git('commit', '-m', 'base')
    upsertProject({ name: 'fixture-project', path: repo, settings: { mcpServer: 'fixture-project' } })
    const script = join(dir, 'DEV-372-must-not-start.sh')
    writeFileSync(script, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "doctor" ]; then
    printf '%s' '{"servers":[{"name":"fixture-project","healthy":true,"checks":[]}]}'
    exit 0
  fi
done
printf started > "${join(repo, 'started')}"
exit 0
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    grok.bin = script
    try {
      let runId: number | null = null
      try {
        await runJob({
          job: 'review-lens', prompt: 'review', cwd: repo, agent: 'grok',
          mcp: true, lens: 'craft',
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const row = db().query(
        'SELECT status, failure_kind, mcp_connected, mcp_probe FROM run WHERE id=?',
      ).get(runId!) as {
        status: string; failure_kind: string; mcp_connected: number | null; mcp_probe: string
      }
      expect(row.status).toBe('failed')
      expect(row.failure_kind).toBe('mcp_unverified')
      expect(row.mcp_connected).toBe(0)
      expect(parseMcpProbe(row.mcp_probe)?.ok).toBe(false)
      expect(existsSync(join(repo, 'started'))).toBe(false)
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('require with a reachable stdio server launches and records listed tools', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-mcp-reachable-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git('add', 'tracked.txt')
    const server = writeMintedStdioServer(repo)
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'fixture-project': { command: process.execPath, args: [server] },
      },
    }))
    git('add', '.mcp.json')
    git('commit', '-m', 'base')
    upsertProject({
      name: 'fixture-project', path: repo,
      settings: { mcpServer: 'fixture-project', mcp: { probe_tool: 'ping' } },
    })
    const reply = join(dir, 'DEV-372-reachable-reply.json')
    writeFileSync(reply, JSON.stringify(reviewReply(0)))
    const script = join(dir, 'DEV-372-reachable-start.sh')
    writeFileSync(script, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "doctor" ]; then
    printf '%s' '{"servers":[{"name":"fixture-project","healthy":true,"checks":[]}]}'
    exit 0
  fi
done
printf started > "${join(repo, 'started')}"
cat ${JSON.stringify(reply)}
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    grok.bin = script
    try {
      let runId: number | null = null
      try {
        runId = (await runJob({
          job: 'review-lens', prompt: 'review', cwd: repo, agent: 'grok',
          mcp: true, lens: 'craft',
        })).id
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      expect(existsSync(join(repo, 'started'))).toBe(true)
      const row = db().query(
        'SELECT mcp_connected, mcp_probe FROM run WHERE id=?',
      ).get(runId!) as { mcp_connected: number | null; mcp_probe: string }
      expect(row.mcp_connected).toBe(1)
      const probe = parseMcpProbe(row.mcp_probe)
      expect(probe?.ok).toBe(true)
      expect(probe?.tool).toBe('ping')
      expect(probe?.detail).toBe('listed: 1 tools; called ping')
      expect(probe?.namesSeen).toContain('fixture-project')
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('require records wrong-project tools and starts no agent', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-mcp-wrong-project-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git('add', 'tracked.txt')
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({
      mcpServers: { 'fixture-project': { url: 'http://127.0.0.1:1/mcp' } },
    }))
    git('add', '.mcp.json')
    git('commit', '-m', 'base')
    upsertProject({ name: 'fixture-project', path: repo, settings: { mcpServer: 'fixture-project' } })
    const script = join(dir, 'DEV-372-wrong-project.sh')
    writeFileSync(script, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "doctor" ]; then
    printf '%s' '{"servers":[{"name":"alephbeis","healthy":true,"checks":[]}]}'
    exit 0
  fi
done
printf started > "${join(repo, 'started')}"
exit 0
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    grok.bin = script
    try {
      let runId: number | null = null
      try {
        await runJob({
          job: 'review-lens', prompt: 'review', cwd: repo, agent: 'grok',
          mcp: true, lens: 'craft',
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const row = db().query(
        'SELECT status, mcp_connected, mcp_error FROM run WHERE id=?',
      ).get(runId!) as { status: string; mcp_connected: number | null; mcp_error: string }
      expect(row.status).toBe('failed')
      expect(row.mcp_connected).toBe(0)
      expect(row.mcp_error).toBe('wrong project: saw alephbeis and not fixture-project')
      expect(existsSync(join(repo, 'started'))).toBe(false)
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('codex refuses a different project config before agent start', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-mcp-codex-wrong-project-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({
      mcpServers: { alephbeis: { url: 'http://127.0.0.1:1/mcp' } },
    }))
    git('add', 'tracked.txt', '.mcp.json')
    git('commit', '-m', 'base')
    upsertProject({ name: 'fixture-project', path: repo, settings: { mcpServer: 'fixture-project' } })
    const script = join(dir, 'DEV-372-codex-wrong-project.sh')
    writeFileSync(script, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.153.4'; exit 0; fi
printf started > "${join(repo, 'started')}"
exit 0
`)
    chmodSync(script, 0o755)
    const codex = AGENTS.codex!
    const previous = { bin: codex.bin, argv: codex.argv }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    codex.bin = script
    codex.argv = () => []
    try {
      let runId: number | null = null
      try {
        await runJob({
          job: 'review-lens', prompt: 'review', cwd: repo, agent: 'codex',
          mcp: true, lens: 'craft',
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const row = db().query(
        'SELECT status, mcp_connected, mcp_error, mcp_probe FROM run WHERE id=?',
      ).get(runId!) as {
        status: string; mcp_connected: number; mcp_error: string; mcp_probe: string
      }
      expect(row).toMatchObject({
        status: 'failed', mcp_connected: 0,
        mcp_error: 'wrong project: saw alephbeis and not fixture-project',
      })
      expect(parseMcpProbe(row.mcp_probe)).toMatchObject({
        server: 'fixture-project', tool: 'tools/list', ok: false,
        error: 'wrong project: saw alephbeis and not fixture-project',
      })
      expect(existsSync(join(repo, 'started'))).toBe(false)
    } finally {
      codex.bin = previous.bin
      codex.argv = previous.argv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('require records extra .mcp.json servers from the probe when doctor does not', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-mcp-probe-wrong-project-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git('add', 'tracked.txt')
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'fixture-project': { url: 'http://127.0.0.1:1/mcp' },
        alephbeis: { url: 'http://127.0.0.1:1/alephbeis' },
      },
    }))
    git('add', '.mcp.json')
    git('commit', '-m', 'base')
    upsertProject({ name: 'fixture-project', path: repo, settings: { mcpServer: 'fixture-project' } })
    const script = join(dir, 'DEV-372-probe-wrong-project.sh')
    writeFileSync(script, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "doctor" ]; then
    printf '%s' '{"servers":[{"name":"fixture-project","healthy":true,"checks":[]}]}'
    exit 0
  fi
done
printf started > "${join(repo, 'started')}"
exit 0
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    grok.bin = script
    try {
      let runId: number | null = null
      try {
        await runJob({
          job: 'review-lens', prompt: 'review', cwd: repo, agent: 'grok',
          mcp: true, lens: 'craft',
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const row = db().query(
        'SELECT status, mcp_connected, mcp_error, mcp_probe FROM run WHERE id=?',
      ).get(runId!) as {
        status: string; mcp_connected: number | null; mcp_error: string; mcp_probe: string
      }
      expect(row.status).toBe('failed')
      expect(row.mcp_connected).toBe(0)
      // The required server is present beside alephbeis, so this is not a
      // wrong-project tree; the probe fails on the unreachable endpoint and
      // records every configured name.
      expect(row.mcp_error).not.toStartWith('wrong project')
      const probe = parseMcpProbe(row.mcp_probe)
      expect(probe?.ok).toBe(false)
      expect(probe?.error).toBe(row.mcp_error)
      expect(probe?.namesSeen).toContain('fixture-project')
      expect(probe?.namesSeen).toContain('alephbeis')
      expect(existsSync(join(repo, 'started'))).toBe(false)
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('prefer with an unreachable server launches and records 0', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-mcp-prefer-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git('add', 'tracked.txt')
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({
      mcpServers: { 'fixture-project': { url: 'http://127.0.0.1:1/mcp' } },
    }))
    git('add', '.mcp.json')
    git('commit', '-m', 'base')
    upsertProject({ name: 'fixture-project', path: repo, settings: { mcpServer: 'fixture-project' } })
    const reply = join(dir, 'DEV-372-prefer-reply.json')
    writeFileSync(reply, JSON.stringify(reviewReply(0)))
    const script = join(dir, 'DEV-372-prefer-start.sh')
    writeFileSync(script, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "doctor" ]; then
    printf '%s' '{"servers":[{"name":"fixture-project","healthy":true,"checks":[]}]}'
    exit 0
  fi
done
cat ${JSON.stringify(reply)}
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    grok.bin = script
    try {
      let runId: number | null = null
      try {
        const result = await runJob({
          job: 'review-lens', prompt: 'review', cwd: repo, agent: 'grok',
          mcp: 'prefer', lens: 'craft',
        })
        runId = result.id
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const row = db().query(
        'SELECT mcp_connected, mcp_probe FROM run WHERE id=?',
      ).get(runId!) as { mcp_connected: number | null; mcp_probe: string }
      expect(row.mcp_connected).toBe(0)
      expect(parseMcpProbe(row.mcp_probe)?.ok).toBe(false)
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('mcp config parse', () => {
  test('reads mcpServers url and command', () => {
    const parsed = parseMcpConfig(JSON.stringify({
      mcpServers: {
        starship: { url: 'https://starship.example/mcp' },
        local: { command: 'bun', args: ['server.ts'] },
      },
    }))
    expect(parsed.starship?.url).toBe('https://starship.example/mcp')
    expect(parsed.local?.command).toBe('bun')
  })
})
