import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { addRun, db, dir, recordReview, reviewReply, runCollectionDescribeFixture } from '../fixture.ts'

const GRAPH = ['clock.ts', 'collect.ts', 'failure.ts', 'mcp-probe.ts', 'orch.ts', 'outcome.ts', 'result-output.ts']
const SRC = resolve(dirname(new URL(import.meta.url).pathname), '../../src')
function specs(source: string) {
  const found: string[] = []
  for (const match of source.matchAll(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) {
    if (!match[1]!.trim().startsWith('type ') && match[2]!.startsWith('.')) found.push(match[2]!)
  }
  for (const match of source.matchAll(/^import\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) if (match[1]!.startsWith('.')) found.push(match[1]!)
  for (const match of source.matchAll(/^export\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) if (match[1]!.startsWith('.')) found.push(match[1]!)
  return found
}
function closure(entry: string) {
  const seen = new Set<string>(); const queue = [entry]
  while (queue.length) { const file = resolve(queue.pop()!); if (seen.has(file)) continue; seen.add(file); for (const spec of specs(readFileSync(file, 'utf8'))) queue.push(resolve(dirname(file), spec)) }
  return [...seen].map((file) => relative(SRC, file)).sort()
}
function shadow(path: string) {
  const files = closure(join(SRC, 'orch.ts'))
  expect(files).toEqual([...GRAPH].sort())
  mkdirSync(path, { recursive: true })
  for (const file of files) { const destination = join(path, file); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, readFileSync(join(SRC, file), 'utf8')) }
  writeFileSync(join(path, 'cli.ts'), '<<<<<<< ours\n')
}

describe('degraded collection process boundary', () => {
  const { insert, scoreReminder } = runCollectionDescribeFixture()

  test('result falls back to the run row and output when the full CLI cannot parse', () => {
    const id = insert('ok'); const output = join(dir, `degraded-result-${id}.txt`); writeFileSync(output, 'already-paid-for answer'); db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
    const copy = join(dir, `degraded-result-cli-${id}`); shadow(copy)
    const result = Bun.spawnSync([process.execPath, join(copy, 'orch.ts'), 'result', String(id), '--quiet'], { env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toContain('already-paid-for answer'); expect(result.stderr.toString()).toContain('degraded collection mode'); expect(result.stderr.toString()).toContain('full CLI could not load')
  })

  test('wait falls back without loading the broken CLI graph', () => {
    const ok = insert('ok'); const failed = insert('failed'); db().query("UPDATE run SET failure_kind='harness',error='agent stopped' WHERE id=?").run(failed)
    const copy = join(dir, `degraded-wait-cli-${failed}`); shadow(copy)
    const result = Bun.spawnSync([process.execPath, join(copy, 'orch.ts'), 'wait', String(ok), String(failed)], { env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(1); expect(result.stdout.toString()).toContain(`${ok}\tok`); expect(result.stdout.toString()).toContain(`${failed}\tfailed`); expect(result.stderr.toString()).toContain('degraded collection mode')
  })

  test('the Stop hook names judge and every missing findings flag', () => {
    const subject = addRun({ agent: 'grok', job: 'review-lens', session: 'judge-hook-session', lens: 'correctness' }); recordReview(subject, reviewReply(2, 'high'), db())
    const reminder = scoreReminder('judge-hook-session').stdout.toString(); expect(reminder).toContain(`orch judge ${subject}`)
    for (const flag of ['--reproduced', '--coverage', '--limits', '--overlap', '--finding 1=', '--finding 2=']) expect(reminder).toContain(flag)
  })
})
