import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from './brand.ts'
import { parseBuiltCommit } from './built-commit.ts'
import { embeddedDistributionManifest } from './embedded-assets.ts'

export type InstallEnvironment = Record<string, string | undefined>

/** The platform-specific installation-root override is derived from the one canonical slug. */
export const INSTALL_HOME_ENV = `${PLATFORM_SLUG.toUpperCase()}_HOME`

export const DIST_MANIFEST = `.${PLATFORM_SLUG}-dist.json`

export type DistributionManifest = {
  name: typeof PLATFORM_NAME
  version: string
  built: string
  commit: string
}

export type InstallationPaths = {
  root: string
  executable: string
  ops: string
  hubAssets: string
}

type InstallationIdentity =
  | { kind: 'distribution'; root: string; manifest: DistributionManifest }
  | { kind: 'checkout'; root: string; version: string }

class InstallRootNotFoundError extends Error {}

function isDistributionRoot(directory: string): boolean {
  return existsSync(join(directory, DIST_MANIFEST))
}

function isCheckoutRoot(directory: string): boolean {
  const manifest = join(directory, 'package.json')
  if (!existsSync(manifest)) return false
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
    return parsed.name === PLATFORM_SLUG
  } catch {
    return false
  }
}

/** Resolve the running distribution or checkout using only the supplied start and environment. */
export function resolveInstallRoot(fromDirectory: string, env: InstallEnvironment): string {
  if (embeddedDistributionManifest()) return dirname(process.execPath)
  const override = env[INSTALL_HOME_ENV]
  if (override && isAbsolute(override)) return override
  let directory = fromDirectory
  for (;;) {
    if (isDistributionRoot(directory) || isCheckoutRoot(directory)) return directory
    const parent = dirname(directory)
    if (parent === directory) {
      throw new InstallRootNotFoundError(
        `cannot resolve the ${PLATFORM_SLUG} installation root: neither ${DIST_MANIFEST} nor a package.json named ${PLATFORM_SLUG} was found walking from ${fromDirectory}; set ${INSTALL_HOME_ENV} to the absolute installation root`,
      )
    }
    directory = parent
  }
}

/** Resolve every path rendered into a service definition from the same installation root. */
export function resolveInstallationPaths(
  fromDirectory: string,
  env: InstallEnvironment,
): InstallationPaths {
  const root = resolveInstallRoot(fromDirectory, env)
  return {
    root,
    executable: join(root, 'bin', PLATFORM_SLUG),
    ops: join(root, 'ops'),
    hubAssets: join(root, 'hub'),
  }
}

function damagedManifest(path: string, root: string, detail: string): Error {
  return new Error(
    `cannot establish an authorized ${PLATFORM_NAME} installation: distribution manifest ${path} is damaged: ${detail}\n` +
      'invariant: An installed distribution has a valid distribution manifest.\n' +
      `cleared by: reinstall ${PLATFORM_NAME} at ${root}`,
  )
}

/** Validate the distribution manifest once, where bytes from disk enter the program. */
export function readDistributionManifest(root: string): DistributionManifest | null {
  const embedded = embeddedDistributionManifest()
  if (embedded) return embedded
  const path = join(root, DIST_MANIFEST)
  if (!existsSync(path)) return null
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw damagedManifest(path, root, error instanceof Error ? error.message : String(error))
  }
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (
    !row ||
    row.name !== PLATFORM_NAME ||
    typeof row.version !== 'string' ||
    !row.version.trim() ||
    typeof row.built !== 'string' ||
    !row.built.trim() ||
    Number.isNaN(Date.parse(row.built)) ||
    typeof row.commit !== 'string' ||
    !row.commit.trim()
  ) {
    throw damagedManifest(
      path,
      root,
      `expected name ${JSON.stringify(PLATFORM_NAME)} and non-empty version, ISO 8601 built, and commit strings`,
    )
  }
  return {
    name: PLATFORM_NAME,
    version: row.version,
    built: row.built,
    commit: row.commit,
  }
}

/** Read the identity of the running distribution or checkout. */
function installationIdentity(
  fromDirectory: string,
  env: InstallEnvironment,
): InstallationIdentity {
  const embedded = embeddedDistributionManifest()
  if (embedded) return { kind: 'distribution', root: dirname(process.execPath), manifest: embedded }
  const root = resolveInstallRoot(fromDirectory, env)
  const manifest = readDistributionManifest(root)
  if (manifest) return { kind: 'distribution', root, manifest }
  const path = join(root, 'package.json')
  try {
    const row = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (row.name !== PLATFORM_SLUG || typeof row.version !== 'string' || !row.version.trim()) {
      throw new Error('package name or version is invalid')
    }
    return { kind: 'checkout', root, version: row.version }
  } catch (error) {
    throw new Error(
      `cannot read ${PLATFORM_NAME} checkout package metadata at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Answer exactly: is this an authorized platform installation? */
export function isAuthorizedPlatformInstallation(
  fromDirectory: string,
  env: InstallEnvironment,
  checkoutAuthorized: boolean,
): boolean {
  if (embeddedDistributionManifest()) return true
  try {
    const root = resolveInstallRoot(fromDirectory, env)
    if (readDistributionManifest(root)) return true
  } catch (error) {
    if (!(error instanceof InstallRootNotFoundError)) throw error
  }
  return checkoutAuthorized
}

/** User-facing version text, distinguished between releases and development checkouts. */
export function installationVersionText(fromDirectory: string, env: InstallEnvironment): string {
  const identity = installationIdentity(fromDirectory, env)
  return identity.kind === 'distribution'
    ? `${identity.manifest.name} ${identity.manifest.version} (${identity.manifest.commit.slice(0, 7)})`
    : `${PLATFORM_NAME} ${identity.version} (development checkout)`
}

function gitCommonDir(root: string): string | null {
  const dotGit = join(root, '.git')
  if (!existsSync(dotGit)) return null
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const pointer = readFileSync(dotGit, 'utf8').trim()
    if (!pointer.startsWith('gitdir: ')) return null
    const gitDir = resolve(root, pointer.slice('gitdir: '.length).trim())
    return resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
  } catch {
    return null
  }
}

function commitFromPackedRefs(gitDir: string, ref: string): string | undefined {
  let packed: string
  try {
    packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
  } catch {
    return undefined
  }
  for (const line of packed.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue
    const space = line.indexOf(' ')
    if (space <= 0) continue
    if (line.slice(space + 1).trim() === ref) return parseBuiltCommit(line.slice(0, space))
  }
  return undefined
}

function commitAtRef(gitDir: string, ref: string): string | undefined {
  try {
    const loose = parseBuiltCommit(readFileSync(join(gitDir, ref), 'utf8'))
    if (loose) return loose
  } catch {
    // packed-refs is the remaining source for this name
  }
  return commitFromPackedRefs(gitDir, ref)
}

/** Main checkout HEAD, read from git files without spawning a process. */
export function checkoutHeadCommit(root: string): string | undefined {
  const gitDir = gitCommonDir(root)
  if (!gitDir) return undefined
  let head: string
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  } catch {
    return undefined
  }
  const detached = parseBuiltCommit(head)
  if (detached) return detached
  if (!head.startsWith('ref: ')) return undefined
  return commitAtRef(gitDir, head.slice('ref: '.length).trim())
}

/** Installed build identity: distribution commit, or the main checkout's current commit. */
export function installationBuildId(fromDirectory: string, env: InstallEnvironment): string | null {
  const identity = installationIdentity(fromDirectory, env)
  if (identity.kind === 'distribution') return identity.manifest.commit
  return checkoutHeadCommit(identity.root) ?? null
}

/** The root of the running distribution or checkout. */
export function installRoot(): string {
  return resolveInstallRoot(import.meta.dir, process.env)
}

/** Join segments against the running distribution or checkout root. */
export function assetPath(...segments: string[]): string {
  return join(installRoot(), ...segments)
}

if (import.meta.main) {
  const [command, fromDirectory] = process.argv.slice(2)
  if (command !== 'root' || !fromDirectory) {
    throw new Error('working form: bun shared/install-root.ts root <from-directory>')
  }
  console.log(resolveInstallationPaths(fromDirectory, process.env).root)
}
