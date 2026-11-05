import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import {
  artifactName,
  parseSha256Sums,
  releaseChannelPath,
  releaseTarget,
} from './release-artifacts.ts'

const digest = 'a'.repeat(64)

test('release artifact names and channel paths are canonical', () => {
  expect(artifactName('1.2.3', 'linux-x64')).toBe(`${PLATFORM_SLUG}-1.2.3-linux-x64.tar.gz`)
  expect(releaseChannelPath()).toBe('latest/download/')
  expect(releaseChannelPath('1.2.3')).toBe('download/v1.2.3/')
})

test('SHA256SUMS parser accepts valid text and refuses malformed lines', () => {
  expect(parseSha256Sums(`${digest.toUpperCase()}  file.tar.gz\n`)).toEqual(
    new Map([['file.tar.gz', digest]]),
  )
  expect(() => parseSha256Sums(`${digest} file.tar.gz`)).toThrow('invalid SHA256SUMS line')
})

test('release targets normalize supported host names', () => {
  expect(releaseTarget('linux', 'aarch64')).toBe('linux-arm64')
  expect(releaseTarget('darwin', 'x86_64')).toBe('darwin-x64')
  expect(releaseTarget('linux', 'amd64')).toBe('linux-x64')
  expect(releaseTarget('linux', 'mips')).toBeNull()
  expect(releaseTarget('win32', 'x64')).toBeNull()
})
