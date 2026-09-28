import { join } from 'node:path'

export type AppStaticResolution =
  | { kind: 'file'; relativePath: string }
  | { kind: 'index'; relativePath: 'index.html' }
  | { kind: '503' }

/** Resolve a root-mounted SPA request without touching the filesystem. */
export function resolveAppStatic(pathname: string, built: boolean): AppStaticResolution {
  if (!built) return { kind: '503' }
  const relativePath = pathname.slice(1)
  if (!relativePath || !relativePath.split('/').at(-1)?.includes('.')) {
    return { kind: 'index', relativePath: 'index.html' }
  }
  return { kind: 'file', relativePath }
}

/**
 * Join a distribution directory and a resolved asset path.
 *
 * Both servers used to concatenate the dist directory and the relative path,
 * which produced `distindex.html` and served a 500 whose headers had already
 * gone out as 200. Joining here leaves the callers nothing to get wrong.
 */
export function appStaticPath(
  dist: string,
  resolution: Extract<AppStaticResolution, { relativePath: string }>,
): string {
  return join(dist, resolution.relativePath)
}
