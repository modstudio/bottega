import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareClaimedWorkerMcpConfig } from './run-worker-home.ts'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

test('a writer gets cwd-discovered MCP configuration and a reader does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-claimed-mcp-'))
  roots.push(root)
  const checkout = join(root, 'checkout')
  const reader = join(root, 'reader')
  const writer = join(root, 'writer')
  mkdirSync(checkout)
  mkdirSync(reader)
  mkdirSync(writer)
  writeFileSync(join(checkout, '.mcp.json'), '{}\n')

  expect(
    prepareClaimedWorkerMcpConfig({
      cwd: reader,
      checkout,
      inherited: false,
      writesRepository: false,
    }),
  ).toBeNull()
  expect(existsSync(join(reader, '.mcp.json'))).toBe(false)

  const prepared = prepareClaimedWorkerMcpConfig({
    cwd: writer,
    checkout,
    inherited: false,
    writesRepository: true,
  })
  expect(prepared?.error).toBeNull()
  expect(readlinkSync(join(writer, '.mcp.json'))).toBe('../checkout/.mcp.json')
})
