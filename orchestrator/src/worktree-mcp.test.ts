import { afterEach, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareWorkerMcpConfig, provisionMcpConfig } from './worktree-mcp.ts'

const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-worker-mcp-')); roots.push(root)
  const checkout = join(root, 'checkout'); const worker = join(root, 'worker')
  mkdirSync(checkout); mkdirSync(worker)
  return { checkout, worker }
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

test('provisions cwd-discovered MCP with a relative symlink and reports it in the output header', () => {
  const { checkout, worker } = fixture(); writeFileSync(join(checkout, '.mcp.json'), '{}\n')
  expect(provisionMcpConfig(worker, checkout)).toEqual({
    header: 'MCP preflight: linked .mcp.json -> ../checkout/.mcp.json', error: null,
  })
  expect(readlinkSync(join(worker, '.mcp.json'))).toBe('../checkout/.mcp.json')
})

test('keeps and measures a real MCP config that replaces the provisioned link', () => {
  const { checkout, worker } = fixture(); writeFileSync(join(checkout, '.mcp.json'), '{}\n')
  const config = prepareWorkerMcpConfig(worker, checkout, false)
  rmSync(join(worker, '.mcp.json')); writeFileSync(join(worker, '.mcp.json'), '{"worker":true}\n')
  expect(config.measure(() => lstatSync(join(worker, '.mcp.json')).isSymbolicLink())).toBe(false)
  expect(lstatSync(join(worker, '.mcp.json')).isSymbolicLink()).toBe(false)
})

test('uses a real MCP config supplied by the project worktree recipe without a checkout copy', () => {
  const { checkout, worker } = fixture(); writeFileSync(join(worker, '.mcp.json'), '{"recipe":true}\n')
  expect(prepareWorkerMcpConfig(worker, checkout, false).measure(() =>
    lstatSync(join(worker, '.mcp.json')).isSymbolicLink())).toBe(false)
})

test('measures a real MCP config carried from the caller worktree', () => {
  const { checkout, worker } = fixture(); writeFileSync(join(checkout, '.mcp.json'), '{}\n')
  writeFileSync(join(worker, '.mcp.json'), '{"carried":true}\n')
  const config = prepareWorkerMcpConfig(worker, checkout, true)
  expect(config.measure(() => existsSync(join(worker, '.mcp.json')))).toBe(true)
  expect(lstatSync(join(worker, '.mcp.json')).isSymbolicLink()).toBe(false)
})
test('refuses cwd-discovered required MCP before agent spawn when the checkout has no config', () => {
  const { checkout, worker } = fixture()
  expect(provisionMcpConfig(worker, checkout)).toEqual({
    header: null,
    error: `missing .mcp.json in worker cwd ${worker}; registered checkout ${checkout} has no .mcp.json either`,
  })
})

test('the provisioned link resolves when the checkout is named through a symlinked prefix', () => {
  const { checkout, worker } = fixture(); writeFileSync(join(checkout, '.mcp.json'), '{"real":true}\n')
  const alias = join(roots[roots.length - 1]!, 'alias'); symlinkSync(checkout, alias)
  const result = provisionMcpConfig(realpathSync(worker), alias)
  expect(result.error).toBeNull()
  expect(existsSync(join(worker, '.mcp.json'))).toBe(true)
  expect(readlinkSync(join(worker, '.mcp.json'))).toBe('../checkout/.mcp.json')
  expect(prepareWorkerMcpConfig(realpathSync(worker), alias, true).measure(() =>
    existsSync(join(worker, '.mcp.json')))).toBe(false)
})
