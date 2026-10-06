import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import {
  sandboxRuntimeAssets,
  sandboxRuntimePayloadPaths,
} from '../../../shared/sandbox-runtime-assets.ts'
import {
  classifySandboxRuntimeAvailability,
  extractSandboxRuntime,
  SRT_LIBRARY,
  sandboxRuntimeAvailability,
} from './sandbox-runtime.ts'

const manifest = {
  name: PLATFORM_NAME,
  version: '1.2.3',
  built: '2026-09-18T12:34:56.000Z',
  commit: 'abcdef1234567890',
} as const

afterEach(() => registerEmbeddedAssets(null))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'srt-extract-'))
  const state = join(root, 'state')
  const sources = new Map<string, string>()
  const assets = sandboxRuntimeAssets('linux', 'arm64')
  for (const asset of Object.values(assets)) {
    const source = join(root, `source-${sources.size}`)
    writeFileSync(source, `embedded ${asset.destination}`)
    sources.set(asset.packagePath, source)
  }
  registerEmbeddedAssets({ assets: {}, files: {}, manifest })
  const ports = {
    environment: { BOTTEGA_STATE_HOME: state },
    platform: 'linux' as const,
    arch: 'arm64' as const,
    resolveFile: (path: string) => sources.get(path),
    readFile: (path: string) => Bun.file(path).arrayBuffer(),
  }
  const final = join(state, 'runtime', manifest.version, 'sandbox-runtime')
  return { root, final, assets, ports }
}

function quarantines(final: string): string[] {
  return readdirSync(dirname(final))
    .filter((name) => name.startsWith('sandbox-runtime.invalid-'))
    .map((name) => join(dirname(final), name))
}

describe('sandbox runtime payloads', () => {
  test('source availability is exactly the installed library check', () => {
    expect(
      sandboxRuntimeAvailability(process.env, process.platform, process.arch, []).available,
    ).toBe(existsSync(SRT_LIBRARY))
    expect(
      sandboxRuntimeAvailability(process.env, process.platform, process.arch, []).location,
    ).toBe(SRT_LIBRARY)
  })

  test('missing system dependencies make the shared ruling unavailable with one remedy', () => {
    expect(
      classifySandboxRuntimeAvailability({
        location: '/runtime',
        runtimePresent: true,
        sourceCheckout: false,
        missingSystemDependencies: [
          'ripgrep (rg) not found',
          'bubblewrap (bwrap) not installed',
          'socat not installed',
        ],
      }),
    ).toEqual({
      available: false,
      location: '/runtime',
      missingSystemDependencies: [
        'ripgrep (rg) not found',
        'bubblewrap (bwrap) not installed',
        'socat not installed',
      ],
      remedy:
        'install the missing sandbox system dependencies with the system package manager (ripgrep (rg) not found, bubblewrap (bwrap) not installed, socat not installed), then retry',
    })
  })

  test('embedded availability requires every host payload without extracting it', () => {
    const state = mkdtempSync(join(tmpdir(), 'srt-availability-'))
    const paths = sandboxRuntimePayloadPaths('linux', 'arm64')
    try {
      registerEmbeddedAssets({ assets: {}, files: {}, manifest })
      expect(
        sandboxRuntimeAvailability({ BOTTEGA_STATE_HOME: state }, 'linux', 'arm64', []),
      ).toEqual({
        available: false,
        location: join(state, 'runtime', manifest.version, 'sandbox-runtime'),
        missingSystemDependencies: [],
        remedy: `reinstall the sandbox runtime at ${join(state, 'runtime', manifest.version, 'sandbox-runtime')}, then retry`,
      })
      registerEmbeddedAssets({
        assets: {},
        files: Object.fromEntries(paths.map((path) => [path, `/embedded/${path}`])),
        manifest,
      })
      expect(
        sandboxRuntimeAvailability({ BOTTEGA_STATE_HOME: state }, 'linux', 'arm64', []).available,
      ).toBe(true)
      expect(existsSync(join(state, 'runtime'))).toBe(false)
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  })

  test('extraction publishes once with exact modes and reuses a verified tree', async () => {
    const { root, final, assets, ports } = fixture()
    try {
      const first = await extractSandboxRuntime(ports)
      const inode = statSync(first.root).ino
      expect(first.root).toBe(final)
      expect(readFileSync(first.javaAgentJarPath, 'utf8')).toBe(
        `embedded ${assets.javaAgent.destination}`,
      )
      expect(statSync(first.javaAgentJarPath).mode & 0o777).toBe(0o644)
      expect(statSync(first.seccompApplyPath!).mode & 0o777).toBe(0o755)

      const second = await extractSandboxRuntime(ports)
      expect(second).toEqual(first)
      expect(statSync(second.root).ino).toBe(inode)
      expect(quarantines(final)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a substituted helper is quarantined and replaced with embedded bytes', async () => {
    const { root, final, assets, ports } = fixture()
    try {
      const first = await extractSandboxRuntime(ports)
      writeFileSync(first.seccompApplyPath!, 'substituted')
      chmodSync(first.seccompApplyPath!, 0o755)

      const repaired = await extractSandboxRuntime(ports)
      expect(readFileSync(repaired.seccompApplyPath!, 'utf8')).toBe(
        `embedded ${assets.seccompApply!.destination}`,
      )
      expect(quarantines(final)).toHaveLength(1)
      expect(
        readFileSync(join(quarantines(final)[0]!, assets.seccompApply!.destination), 'utf8'),
      ).toBe('substituted')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a symlinked payload is rejected and replaced', async () => {
    const { root, final, assets, ports } = fixture()
    try {
      const first = await extractSandboxRuntime(ports)
      rmSync(first.javaAgentJarPath)
      symlinkSync(join(root, 'source-0'), first.javaAgentJarPath)

      const repaired = await extractSandboxRuntime(ports)
      expect(lstatSync(repaired.javaAgentJarPath).isSymbolicLink()).toBe(false)
      expect(readFileSync(repaired.javaAgentJarPath, 'utf8')).toBe(
        `embedded ${assets.javaAgent.destination}`,
      )
      expect(quarantines(final)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a symlinked payload directory is rejected and replaced', async () => {
    const { root, final, assets, ports } = fixture()
    try {
      await extractSandboxRuntime(ports)
      const vendor = join(final, 'vendor')
      rmSync(vendor, { recursive: true })
      symlinkSync(root, vendor)

      const repaired = await extractSandboxRuntime(ports)
      expect(lstatSync(join(repaired.root, 'vendor')).isSymbolicLink()).toBe(false)
      expect(readFileSync(repaired.javaAgentJarPath, 'utf8')).toBe(
        `embedded ${assets.javaAgent.destination}`,
      )
      expect(quarantines(final)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a symlinked version directory is quarantined before extraction', async () => {
    const { root, final, assets, ports } = fixture()
    const version = dirname(final)
    const planted = join(root, 'planted-version')
    try {
      mkdirSync(dirname(version), { recursive: true })
      symlinkSync(planted, version)

      const repaired = await extractSandboxRuntime(ports)
      expect(lstatSync(version).isSymbolicLink()).toBe(false)
      expect(readFileSync(repaired.javaAgentJarPath, 'utf8')).toBe(
        `embedded ${assets.javaAgent.destination}`,
      )
      expect(
        readdirSync(dirname(version)).filter((name) => name.startsWith('1.2.3.invalid-')),
      ).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a wrong payload mode is rejected and replaced', async () => {
    const { root, final, ports } = fixture()
    try {
      const first = await extractSandboxRuntime(ports)
      chmodSync(first.javaAgentJarPath, 0o666)

      const repaired = await extractSandboxRuntime(ports)
      expect(statSync(repaired.javaAgentJarPath).mode & 0o777).toBe(0o644)
      expect(quarantines(final)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an incomplete tree is rejected and replaced', async () => {
    const { root, final, ports } = fixture()
    try {
      const first = await extractSandboxRuntime(ports)
      rmSync(first.seccompApplyPath!)

      const repaired = await extractSandboxRuntime(ports)
      expect(existsSync(repaired.seccompApplyPath!)).toBe(true)
      expect(quarantines(final)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the losing side of a publication race verifies and reuses the winner', async () => {
    const { root, final, ports } = fixture()
    try {
      const [first, second] = await Promise.all([
        extractSandboxRuntime(ports),
        extractSandboxRuntime(ports),
      ])
      expect(second).toEqual(first)
      expect(existsSync(final)).toBe(true)
      expect(quarantines(final)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('failed extraction never exposes the final directory', async () => {
    const state = mkdtempSync(join(tmpdir(), 'srt-partial-'))
    registerEmbeddedAssets({ assets: {}, files: {}, manifest })
    const final = join(state, 'runtime', manifest.version, 'sandbox-runtime')
    try {
      await expect(
        extractSandboxRuntime({
          environment: { BOTTEGA_STATE_HOME: state },
          platform: 'linux',
          arch: 'arm64',
          resolveFile: () => '/fake',
          readFile: async () => {
            throw new Error('interrupted read')
          },
        }),
      ).rejects.toThrow('interrupted read')
      expect(existsSync(final)).toBe(false)
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  })
})
