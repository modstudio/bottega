import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, InMemoryTransport, type Tool } from '@modelcontextprotocol/client'
import {
  createReaderMcpProxy,
  MCP_UPSTREAM_INHERITED_ENV,
  type ReaderMcpUpstream,
  readerMcpProxyCommand,
  readerMcpUpstreamEnvironment,
} from './mcp-reader-proxy.ts'

test('upstream environment contains only declared and allowlisted values', () => {
  const environment = {
    PATH: '/bin',
    HOME: '/reader',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp/reader',
    USER: 'reader',
    SHELL: '/bin/zsh',
    BOTTEGA_RUN_TOKEN: 'run-token-secret',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    OPENAI_API_KEY: 'harness-key',
  }
  expect(readerMcpUpstreamEnvironment(environment, { TRACKER_TOKEN: 'declared-secret' })).toEqual({
    PATH: '/bin',
    HOME: '/reader',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp/reader',
    USER: 'reader',
    SHELL: '/bin/zsh',
    TRACKER_TOKEN: 'declared-secret',
  })
  expect(MCP_UPSTREAM_INHERITED_ENV).toEqual(['PATH', 'HOME', 'LANG', 'TMPDIR', 'USER', 'SHELL'])
})

test('proxy exhausts listing pages, refuses guessed names, and forwards allowed calls unchanged', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const pages: Array<{ tools: Tool[]; nextCursor?: string }> = [
    {
      tools: [
        { name: 'annotated', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'write', inputSchema: { type: 'object' } },
      ],
      nextCursor: 'page-two',
    },
    { tools: [{ name: 'registered', inputSchema: { type: 'object' } }] },
  ]
  const returned = {
    content: [{ type: 'text' as const, text: 'same result' }],
    structuredContent: { same: true },
  }
  const upstream: ReaderMcpUpstream = {
    listTools: async (cursor) => pages[cursor ? 1 : 0]!,
    callTool: async (name, args) => {
      calls.push({ name, args })
      return returned
    },
    close: async () => {},
  }
  const proxy = await createReaderMcpProxy(upstream, {
    server: 'project',
    projectServer: 'project',
    registeredTools: ['registered'],
  })
  const client = new Client({ name: 'reader-proxy-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await proxy.server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'annotated',
      'registered',
    ])
    const refused = await client.callTool({ name: 'guessed-write', arguments: { unsafe: true } })
    expect(refused.isError).toBeTrue()
    expect(refused.content).toEqual([
      { type: 'text', text: 'Reading job may not call tool "guessed-write".' },
    ])
    expect(calls).toEqual([])

    const result = await client.callTool({ name: 'registered', arguments: { value: 7 } })
    expect(result).toEqual(returned)
    expect(calls).toEqual([{ name: 'registered', args: { value: 7 } }])
  } finally {
    await client.close()
    await proxy.close()
  }
})

test('command sanitizes a configured credential from an upstream startup failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reader-proxy-command-'))
  const main = join(root, 'main')
  const tree = join(root, 'tree')
  mkdirSync(main)
  mkdirSync(tree)
  await Bun.write(join(main, '.keep'), '')
  await Bun.write(join(tree, '.keep'), '')
  const errors: string[] = []
  const exitCodes: number[] = []
  try {
    await readerMcpProxyCommand('project', 'tracker', tree, {
      projectByName: () => ({ name: 'project', path: main, settings: {} }),
      retiredProjectByName: () => null,
      readMcpConfigResult: () => ({
        ok: true,
        path: join(main, '.mcp.json'),
        config: {
          tracker: {
            name: 'tracker',
            command: '/missing/server',
            args: ['--token', 'argument-credential-456'],
            env: { TRACKER_TOKEN: 'credential-value-123' },
          },
        },
      }),
      connectMcpToolClient: async () => {
        throw new Error(
          'upstream rejected credential-value-123 after spawn --token argument-credential-456',
        )
      },
      environment: { BOTTEGA_RUN_TOKEN: 'run-token-secret', PATH: '/bin' },
      error: (line) => errors.push(line),
      setExitCode: (code) => exitCodes.push(code),
    })
    expect(errors).toEqual([
      'MCP reader proxy for tracker could not start: upstream rejected [redacted] after spawn --token [redacted]',
    ])
    expect(errors.join('\n')).not.toContain('credential-value-123')
    expect(errors.join('\n')).not.toContain('argument-credential-456')
    expect(exitCodes).toEqual([1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('command distinguishes unavailable launch files and refuses the registered checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reader-proxy-paths-'))
  const errors: string[] = []
  try {
    const project = { name: 'project', path: root, settings: {} }
    const common = {
      projectByName: () => project,
      retiredProjectByName: () => null,
      environment: {},
      error: (line: string) => errors.push(line),
      setExitCode: () => {},
    }
    await readerMcpProxyCommand('project', 'tracker', root, {
      ...common,
      readMcpConfigResult: () => ({
        ok: true,
        path: join(root, '.mcp.json'),
        config: {},
      }),
    })
    expect(errors.pop()).toContain(
      `run tree ${JSON.stringify(root)} is the registered main checkout`,
    )

    const tree = join(root, 'tree')
    mkdirSync(tree)
    await Bun.write(join(tree, '.keep'), '')
    for (const result of [
      { ok: false as const, path: join(root, '.mcp.json'), reason: 'missing' as const },
      { ok: false as const, path: join(root, '.mcp.json'), reason: 'invalid' as const },
      { ok: true as const, path: join(root, '.mcp.json'), config: {} },
    ]) {
      await readerMcpProxyCommand('project', 'tracker', tree, {
        ...common,
        readMcpConfigResult: () => result,
      })
    }
    expect(errors).toEqual([
      expect.stringContaining(`MCP configuration is missing at ${join(root, '.mcp.json')}`),
      expect.stringContaining(`MCP configuration is not valid JSON at ${join(root, '.mcp.json')}`),
      expect.stringContaining(
        `server "tracker" is not configured in ${join(root, '.mcp.json')}; add its launch definition there`,
      ),
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
