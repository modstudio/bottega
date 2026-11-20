import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import { WORKER_RUNTIME_ASSETS } from '../../../shared/runtime-assets-in-sandbox.ts'
import {
  sandboxRuntimeAssets,
  sandboxRuntimePayloadPaths,
} from '../../../shared/sandbox-runtime-assets.ts'
import {
  classifySandboxRuntimeAvailability,
  extractedSandboxRuntimeRoot,
  extractSandboxRuntime,
  packageManagerFromOsRelease,
  prepareSandboxRuntimeConfig,
  sandboxRuntimeAvailability,
  srtLibrary,
  withSandboxTemporaryDirectory,
} from './sandbox-runtime.ts'
import { workerRuntimeReadCarvebacks } from './worker-runtime-read-carvebacks.ts'

const SRT_LIBRARY = srtLibrary()

const availabilityFacts = {
  location: '/runtime',
  runtimePresent: true,
  sourceCheckout: false,
  missingSystemDependencies: [] as string[],
  userNamespacesUsable: true as boolean | null,
  bwrapPath: '/usr/bin/bwrap',
  bwrapProfileLoaded: false,
  packageManager: 'apt' as const,
}

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
  test('the extracted distribution runtime root has one canonical derivation', () => {
    expect(extractedSandboxRuntimeRoot({ BOTTEGA_STATE_HOME: '/operator/state' })).toBeUndefined()
    registerEmbeddedAssets({ assets: {}, files: {}, manifest })
    expect(extractedSandboxRuntimeRoot({ BOTTEGA_STATE_HOME: '/operator/state' })).toBe(
      '/operator/state/runtime/1.2.3/sandbox-runtime',
    )
  })

  test('profile carve-backs and launch payloads use the same explicit state environment', async () => {
    const { root, final, ports } = fixture()
    const previous = process.env.BOTTEGA_STATE_HOME
    process.env.BOTTEGA_STATE_HOME = join(root, 'different-process-state')
    try {
      const carvebacks = workerRuntimeReadCarvebacks(ports.environment, manifest)
      const payload = await prepareSandboxRuntimeConfig(ports.environment, ports)

      expect(carvebacks).toContain(final)
      expect(payload.javaAgentJarPath).toStartWith(`${final}/`)
      expect(payload.seccomp?.applyPath).toStartWith(`${final}/`)
      expect(payload.javaAgentJarPath).not.toContain('different-process-state')
    } finally {
      if (previous === undefined) delete process.env.BOTTEGA_STATE_HOME
      else process.env.BOTTEGA_STATE_HOME = previous
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a checkout carves back only its compiled CLI and stamp beneath the denied state root', () => {
    const carvebacks = workerRuntimeReadCarvebacks(
      { BOTTEGA_STATE_HOME: '/operator/state', HOME: '/operator' },
      null,
    )
    expect(carvebacks).toEqual([
      `/operator/state/runtime/0.5.12/${WORKER_RUNTIME_ASSETS.checkoutCli}`,
      `/operator/state/runtime/0.5.12/${WORKER_RUNTIME_ASSETS.checkoutCliStamp}`,
    ])
    expect(carvebacks).not.toContain('/operator/state')
    expect(
      carvebacks.every((path) => path.startsWith('/operator/state/runtime/0.5.12/')),
    ).toBeTrue()
  })

  test('temporary directory is scoped to one launch and restored before the next', async () => {
    const previous = process.env.CLAUDE_CODE_TMPDIR
    let releaseFirst = () => {}
    let firstEntered = () => {}
    const firstIsEntered = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const observed: string[] = []

    const first = withSandboxTemporaryDirectory('/runs/first/tmp', async () => {
      observed.push(process.env.CLAUDE_CODE_TMPDIR ?? 'missing')
      firstEntered()
      await firstMayFinish
      observed.push(process.env.CLAUDE_CODE_TMPDIR ?? 'missing')
    })
    await firstIsEntered
    const second = withSandboxTemporaryDirectory('/runs/second/tmp', async () => {
      observed.push(process.env.CLAUDE_CODE_TMPDIR ?? 'missing')
    })
    await Promise.resolve()
    try {
      expect(observed).toEqual(['/runs/first/tmp'])
    } finally {
      releaseFirst()
    }
    await Promise.all([first, second])
    expect(observed).toEqual(['/runs/first/tmp', '/runs/first/tmp', '/runs/second/tmp'])
    expect(process.env.CLAUDE_CODE_TMPDIR).toBe(previous)
  })

  test('temporary directory is restored when a launch rejects', async () => {
    const previous = process.env.CLAUDE_CODE_TMPDIR
    await expect(
      withSandboxTemporaryDirectory('/runs/rejected/tmp', async () => {
        expect(process.env.CLAUDE_CODE_TMPDIR).toBe('/runs/rejected/tmp')
        throw new Error('launch rejected')
      }),
    ).rejects.toThrow('launch rejected')
    expect(process.env.CLAUDE_CODE_TMPDIR).toBe(previous)
    await withSandboxTemporaryDirectory(undefined, async () => {
      expect(process.env.CLAUDE_CODE_TMPDIR).toBe(previous)
    })
  })

  test('source availability is exactly the installed library check', async () => {
    expect(
      (await sandboxRuntimeAvailability(process.env, process.platform, process.arch, [])).available,
    ).toBe(existsSync(SRT_LIBRARY))
    expect(
      (await sandboxRuntimeAvailability(process.env, process.platform, process.arch, [])).location,
    ).toBe(SRT_LIBRARY)
  })

  test('pinned Linux wrapper keeps the namespace probe confinement flags', async () => {
    const { cleanupBwrapMountPoints, wrapCommandWithSandboxLinux } = await import(
      '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'
    )
    try {
      const command = await wrapCommandWithSandboxLinux({
        command: 'true',
        needsNetworkRestriction: true,
        writeConfig: { allowOnly: [], denyWithinAllow: [] },
        bwrapPath: '/usr/bin/bwrap',
        binShell: '/bin/sh',
      })
      expect(command).toContain('--ro-bind / /')
      expect(command).toContain('--unshare-net')
      expect(command).toContain('--unshare-user')
    } finally {
      cleanupBwrapMountPoints()
    }
  })

  test('pinned Linux wrapper lets a nested write bind override an ancestor read carve-back', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'srt-bind-order-')))
    const denied = join(root, 'denied')
    const readable = join(denied, 'readable')
    const writable = join(readable, 'writable')
    mkdirSync(writable, { recursive: true })
    const { cleanupBwrapMountPoints, wrapCommandWithSandboxLinux } = await import(
      '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'
    )
    try {
      const command = await wrapCommandWithSandboxLinux({
        command: 'true',
        needsNetworkRestriction: false,
        readConfig: { denyOnly: [denied], allowWithinDeny: [readable] },
        writeConfig: { allowOnly: [writable], denyWithinAllow: [] },
        bwrapPath: '/usr/bin/bwrap',
        binShell: '/bin/sh',
      })
      const readBind = `--ro-bind ${readable} ${readable}`
      const writeBind = `--bind ${writable} ${writable}`
      expect(command).toContain(readBind)
      expect(command).toContain(writeBind)
      expect(command.lastIndexOf(writeBind)).toBeGreaterThan(command.indexOf(readBind))
    } finally {
      cleanupBwrapMountPoints()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('missing system dependencies make the shared ruling unavailable with an exact install command', () => {
    const ruling = classifySandboxRuntimeAvailability({
      ...availabilityFacts,
      userNamespacesUsable: false,
      missingSystemDependencies: [
        'ripgrep (rg) not found',
        'bubblewrap (bwrap) not installed',
        'socat not installed',
      ],
    })
    expect(ruling.available).toBe(false)
    expect(ruling.fixes).toEqual(['sudo apt-get install bubblewrap socat ripgrep'])
    expect(ruling.remedy).not.toContain('AppArmor')
  })

  test('os-release selects package managers by ID before ID_LIKE', () => {
    expect(packageManagerFromOsRelease('ID=ubuntu')).toBe('apt')
    expect(packageManagerFromOsRelease('ID=linuxmint\nID_LIKE="ubuntu debian"')).toBe('apt')
    expect(packageManagerFromOsRelease('ID=rocky\nID_LIKE="rhel fedora"')).toBe('dnf')
    expect(packageManagerFromOsRelease('ID=arch')).toBe('pacman')
    expect(packageManagerFromOsRelease('ID=gentoo')).toBe('unknown')
  })

  test('availability remedies keep runtime and namespace fixes in ruling order', () => {
    const reinstall = classifySandboxRuntimeAvailability({
      ...availabilityFacts,
      runtimePresent: false,
      userNamespacesUsable: null,
    })
    expect(reinstall.fixes).toEqual(['reinstall the sandbox runtime at /runtime, then retry'])

    const profile = classifySandboxRuntimeAvailability({
      ...availabilityFacts,
      userNamespacesUsable: false,
    })
    expect(profile.fixes[0]).toContain("sudo tee /etc/apparmor.d/bwrap <<'EOF'")
    expect(profile.fixes[0]).toContain('profile bwrap /usr/bin/bwrap flags=(unconfined)')
    expect(profile.fixes[1]).toBe('sudo systemctl reload apparmor')

    const conflict = classifySandboxRuntimeAvailability({
      ...availabilityFacts,
      userNamespacesUsable: false,
      bwrapProfileLoaded: true,
    })
    expect(conflict.fixes).toEqual([expect.stringContaining('sudo aa-status | grep bwrap')])
    expect(conflict.fixes[0]).toContain('/etc/apparmor.d/bwrap')

    const alternatePath = classifySandboxRuntimeAvailability({
      ...availabilityFacts,
      userNamespacesUsable: false,
      bwrapPath: '/opt/bin/bwrap',
    })
    expect(alternatePath.fixes).toEqual([
      expect.stringContaining('bwrap was found at /opt/bin/bwrap'),
    ])
  })

  test('Linux availability gathers namespace and AppArmor facts through injected ports', async () => {
    const observed: string[][] = []
    const ruling = await sandboxRuntimeAvailability(process.env, 'linux', process.arch, [], {
      readOsRelease: () => 'ID=fedora',
      resolveExecutable: (name) => (name === 'bwrap' ? '/usr/bin/bwrap' : '/bin/sh'),
      probeUserNamespaces: (bwrap, shell) => {
        observed.push([bwrap, shell])
        return false
      },
      readApparmorProfiles: () => 'bwrap (enforce)\n',
    })
    expect(observed).toEqual([['/usr/bin/bwrap', '/bin/sh']])
    expect(ruling.fixes[0]).toContain('sudo aa-status | grep bwrap')
  })

  test('Linux availability treats a namespace probe error as a visible unknown verdict', async () => {
    const ruling = await sandboxRuntimeAvailability(process.env, 'linux', process.arch, [], {
      readOsRelease: () => 'ID=ubuntu',
      resolveExecutable: (name) => (name === 'bwrap' ? '/usr/bin/bwrap' : '/bin/sh'),
      probeUserNamespaces: () => {
        throw new Error('probe exceeded its bound')
      },
    })
    expect(ruling.available).toBe(true)
    expect(ruling.fixes).toEqual([])
    expect(ruling.sandboxProbeUnavailableReason).toBe('probe exceeded its bound')
  })

  test('embedded availability requires every host payload without extracting it', async () => {
    const state = mkdtempSync(join(tmpdir(), 'srt-availability-'))
    const paths = sandboxRuntimePayloadPaths('linux', 'arm64')
    try {
      registerEmbeddedAssets({ assets: {}, files: {}, manifest })
      expect(
        await sandboxRuntimeAvailability({ BOTTEGA_STATE_HOME: state }, 'linux', 'arm64', []),
      ).toMatchObject({
        available: false,
        location: join(state, 'runtime', manifest.version, 'sandbox-runtime'),
        missingSystemDependencies: [],
        fixes: [
          `reinstall the sandbox runtime at ${join(state, 'runtime', manifest.version, 'sandbox-runtime')}, then retry`,
        ],
      })
      registerEmbeddedAssets({
        assets: {},
        files: Object.fromEntries(paths.map((path) => [path, `/embedded/${path}`])),
        manifest,
      })
      expect(
        (await sandboxRuntimeAvailability({ BOTTEGA_STATE_HOME: state }, 'linux', 'arm64', []))
          .available,
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
