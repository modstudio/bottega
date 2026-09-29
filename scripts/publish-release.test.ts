import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BINARY_TARGETS } from './build-binary.ts'
import { artifactName } from './build-release-artifacts.ts'
import { type PublishPorts, publishRelease } from './publish-release.ts'
import { RELEASE_BUN_VERSION } from './release-config.ts'

const head = 'a'.repeat(40)
const otherCommit = 'b'.repeat(40)

function fixtureOutput(commit = head): { output: string; names: string[] } {
  const output = mkdtempSync(join(tmpdir(), 'publish-release-'))
  const names = BINARY_TARGETS.map((target) => artifactName('1.2.3', target))
  for (const name of names) writeFileSync(join(output, name), name)
  writeFileSync(
    join(output, 'SHA256SUMS'),
    `${names
      .map((name) => `${createHash('sha256').update(name).digest('hex')}  ${name}`)
      .join('\n')}\n`,
  )
  writeFileSync(
    join(output, 'release-manifest.json'),
    `${JSON.stringify({
      version: '1.2.3',
      commit,
      bunVersion: RELEASE_BUN_VERSION,
      artifacts: names,
    })}\n`,
  )
  return { output, names }
}

function ports(tagOutput = `${head}\trefs/tags/v1.2.3`): PublishPorts {
  return {
    git: async (argv) => {
      if (argv[0] === 'status') return { exitCode: 0, stdout: '' }
      if (argv[0] === 'rev-parse') return { exitCode: 0, stdout: head }
      if (argv[0] === 'ls-remote') return { exitCode: 0, stdout: tagOutput }
      throw new Error(`unexpected git call: ${argv.join(' ')}`)
    },
    gh: async (argv) => ({ exitCode: argv[1] === 'view' ? 1 : 0, stdout: '' }),
  }
}

test('publish refuses without confirmation before calling command ports', async () => {
  const unused = async () => {
    throw new Error('command port must not be called')
  }
  await expect(
    publishRelease('v1.2.3', '/unused', false, { git: unused, gh: unused }),
  ).rejects.toThrow('would upload')
})

test('publish refuses a dirty tree before inspecting artifacts', async () => {
  const unused = async () => {
    throw new Error('gh port must not be called')
  }
  await expect(
    publishRelease('v1.2.3', '/unused', true, {
      git: async () => ({ exitCode: 0, stdout: ' M package.json' }),
      gh: unused,
    }),
  ).rejects.toThrow('dirty working tree')
})

test('publish accepts matching HEAD, lightweight tag, manifest, and checksums', async () => {
  const { output } = fixtureOutput()
  const calls: string[][] = []
  const matching = ports()
  try {
    await publishRelease('v1.2.3', output, true, {
      git: matching.git,
      gh: async (argv) => {
        calls.push(argv)
        return matching.gh(argv)
      },
    })
    expect(calls.at(-1)).toContain(join(output, 'release-manifest.json'))
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

test('publish resolves an annotated remote tag to its peeled commit', async () => {
  const { output } = fixtureOutput()
  try {
    await expect(
      publishRelease(
        'v1.2.3',
        output,
        true,
        ports(`${otherCommit}\trefs/tags/v1.2.3\n${head}\trefs/tags/v1.2.3^{}`),
      ),
    ).resolves.toBeUndefined()
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

test('publish refuses when HEAD does not match the remote tag commit', async () => {
  const { output } = fixtureOutput()
  try {
    await expect(
      publishRelease('v1.2.3', output, true, ports(`${otherCommit}\trefs/tags/v1.2.3`)),
    ).rejects.toThrow('does not match tag')
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

test('publish refuses when the manifest commit does not match HEAD', async () => {
  const { output } = fixtureOutput(otherCommit)
  try {
    await expect(publishRelease('v1.2.3', output, true, ports())).rejects.toThrow('manifest commit')
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

test('publish refuses an artifact that does not match SHA256SUMS', async () => {
  const { output, names } = fixtureOutput()
  try {
    writeFileSync(
      join(output, 'SHA256SUMS'),
      `${names.map((name) => `${'0'.repeat(64)}  ${name}`).join('\n')}\n`,
    )
    await expect(publishRelease('v1.2.3', output, true, ports())).rejects.toThrow(
      'SHA-256 mismatch',
    )
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
