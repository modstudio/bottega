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
