import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxRuntimePayloadPaths } from '../shared/sandbox-runtime-assets.ts'
import { assertTargetHost, embeddedAssetPaths, parseBinaryTarget } from './build-binary.ts'

test('binary asset paths include files below dot-prefixed directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'binary-assets-'))
  try {
    mkdirSync(join(root, '.well-known'), { recursive: true })
    writeFileSync(join(root, 'app.js'), '')
    writeFileSync(join(root, '.well-known', 'assetlinks.json'), '')

    expect(await embeddedAssetPaths('hub/web/dist', root)).toEqual([
      'hub/web/dist/.well-known/assetlinks.json',
      'hub/web/dist/app.js',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('binary sandbox payloads are selected for the build target only', () => {
  expect(sandboxRuntimePayloadPaths('darwin', 'arm64')).toEqual([
    'orchestrator/node_modules/@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar',
  ])
  expect(sandboxRuntimePayloadPaths('linux', 'x64')).toEqual([
    'orchestrator/node_modules/@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar',
    'orchestrator/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp',
  ])
  expect(sandboxRuntimePayloadPaths('win32', 'arm64')).toEqual([
    'orchestrator/node_modules/@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar',
    'orchestrator/node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/arm64/srt-win.exe',
  ])
})

test('binary targets parse only the four supported glibc and Darwin forms', () => {
  expect(parseBinaryTarget('darwin-arm64')).toBe('darwin-arm64')
  expect(parseBinaryTarget('linux-x64')).toBe('linux-x64')
  expect(() => parseBinaryTarget('linux-x64-musl')).toThrow('Windows and musl are unsupported')
  expect(() => parseBinaryTarget('windows-x64')).toThrow('Windows and musl are unsupported')
  expect(() => assertTargetHost('darwin-arm64', 'linux')).toThrow('must be ad-hoc signed')
})
