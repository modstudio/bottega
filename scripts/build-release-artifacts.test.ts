import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import {
  artifactName,
  buildReleaseArtifacts,
  sha256Line,
  writeChecksumSet,
  writeReleaseManifest,
} from './build-release-artifacts.ts'

test('artifact names and SHA256SUMS lines follow the release format', () => {
  const filename = `${PLATFORM_SLUG}-1.2.3-linux-arm64.tar.gz`
  expect(artifactName('1.2.3', 'linux-arm64')).toBe(filename)
  expect(sha256Line(filename, new TextEncoder().encode('fixture'))).toMatch(
    new RegExp(`^[0-9a-f]{64} {2}${PLATFORM_SLUG}-1\\.2\\.3-linux-arm64\\.tar\\.gz$`),
  )
})

test('checksum and release manifest writers describe the assembled artifacts', () => {
  const output = mkdtempSync(join(tmpdir(), 'release-artifacts-'))
  try {
    const artifact = join(output, artifactName('1.2.3', 'linux-arm64'))
    writeFileSync(artifact, 'fixture')
    writeChecksumSet(output, [artifact])
    writeReleaseManifest(output, {
      version: '1.2.3',
      commit: 'a'.repeat(40),
      bunVersion: '1.4.2',
      artifacts: [basename(artifact)],
    })

    expect(readFileSync(join(output, 'SHA256SUMS'), 'utf8')).toMatch(
      new RegExp(`^[0-9a-f]{64} {2}${basename(artifact)}\\n$`),
    )
    expect(JSON.parse(readFileSync(join(output, 'release-manifest.json'), 'utf8'))).toEqual({
      version: '1.2.3',
      commit: 'a'.repeat(40),
      bunVersion: '1.4.2',
      artifacts: [basename(artifact)],
    })
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

test('release artifact assembly refuses a dirty tree before building', async () => {
  await expect(
    buildReleaseArtifacts('v1.2.3', '/unused', {
      git: async () => ({ exitCode: 0, stdout: ' M package.json' }),
    }),
  ).rejects.toThrow('dirty working tree')
})
