import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { formatCheckoutCliStamp } from '../../../shared/runtime-assets-in-sandbox.ts'
import { checkoutCliBuildFailure, verifyCheckoutCliBuild } from './checkout-cli-build.ts'

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('published checkout CLI verification covers hashes and launch metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'checkout-cli-build-'))
  const binary = join(root, 'cli')
  const lockfile = join(root, 'lock')
  const stamp = join(root, 'stamp')
  try {
    writeFileSync(binary, 'compiled bytes')
    writeFileSync(lockfile, 'locked dependencies')
    const metadata = statSync(binary)
    const build = {
      binary,
      stamp,
      lockfile,
      head: 'abc123',
      lockHash: hash(lockfile),
      binaryHash: hash(binary),
      size: metadata.size,
      mtime: Math.trunc(metadata.mtimeMs / 1_000),
      inode: metadata.ino,
    }
    writeFileSync(
      stamp,
      formatCheckoutCliStamp({
        head: build.head,
        lock: build.lockHash,
        binary: build.binaryHash,
        size: build.size,
        mtime: build.mtime,
        inode: build.inode,
      }),
    )
    expect(() => verifyCheckoutCliBuild(build)).not.toThrow()
    writeFileSync(binary, 'tampered compiled bytes')
    expect(() => verifyCheckoutCliBuild(build)).toThrow('binary verification failed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the checkout CLI build failure names machine update as the clearing command', () => {
  expect(checkoutCliBuildFailure('compile failed').message).toEndWith(
    `cleared by: ${PLATFORM_SLUG} machine update`,
  )
})
