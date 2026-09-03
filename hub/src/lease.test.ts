/**
 * The collect lease, on a database of its own.
 *
 * A separate file because `db.ts` reads HUB_DB when it is first imported, and
 * static imports hoist above any assignment - so the path has to be set before
 * collect.ts is pulled in, which means importing it dynamically.
 */
import { expect, test, describe } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'hub-lease-'))
process.env.HUB_DB = join(dir, 'lease.db')
const { acquireLease, releaseLease, leaseHolder, withLease } = await import('./collect.ts')

describe('collect lease', () => {
  test('only one holder at a time', () => {
    expect(acquireLease('a')).toBe(true)
    expect(acquireLease('b')).toBe(false)
    expect(leaseHolder()).toBe('a')
    releaseLease('a')
    expect(acquireLease('b')).toBe(true)
    releaseLease('b')
  })

  test('a one-shot collect waits for the lease instead of racing it', async () => {
    // This is the bug: `hub collect` called collect() directly and never took
    // the lease, so it interleaved with the server's watcher while the
    // transcripts leg was clearing and rewriting a session's spans. Two
    // identical collects beside `hub serve` disagreed by two hours.
    acquireLease('watcher')
    let ran = false
    const r = await withLease('one-shot', async () => { ran = true }, 300)
    expect(r.ran).toBe(false)
    expect(ran).toBe(false)
    if (!r.ran) expect(r.heldBy).toBe('watcher')
    releaseLease('watcher')
  })

  test('and proceeds once the holder hands it back', async () => {
    acquireLease('watcher')
    setTimeout(() => releaseLease('watcher'), 100)
    let ran = false
    const r = await withLease('one-shot', async () => { ran = true }, 5000)
    expect(r.ran).toBe(true)
    expect(ran).toBe(true)
    // Handed back on the way out, so the next collector is not made to wait.
    expect(leaseHolder()).toBeNull()
  })

  test('the lease is released even when the collect throws', async () => {
    await expect(withLease('boom', async () => { throw new Error('leg failed') }, 500))
      .rejects.toThrow('leg failed')
    expect(leaseHolder()).toBeNull()
  })
})

process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
