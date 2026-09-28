import { join } from 'node:path'
import { resolveInstallFile } from '../../shared/embedded-assets.ts'
import { assetPath } from '../../shared/install-root.ts'
import { appStaticPath, resolveAppStatic } from './app-static.ts'

const DIST = join('hub', 'web', 'dist')
const NOT_BUILT = 'hub/web is not built: cd hub/web && bun run build'

function installFile(relativePath: string): string | undefined {
  return resolveInstallFile(relativePath, assetPath(relativePath))
}

function notBuilt(): Response {
  return new Response(NOT_BUILT, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/** Serve the local dashboard from its source build or the current binary's embedded files. */
export async function localAppStaticResponse(pathname: string): Promise<Response> {
  const indexPath = installFile(join(DIST, 'index.html'))
  const built = indexPath !== undefined && (await Bun.file(indexPath).exists())
  const resolved = resolveAppStatic(pathname, built)
  if (resolved.kind === '503') return notBuilt()

  const path = installFile(appStaticPath(DIST, resolved))
  if (path === undefined) {
    return resolved.kind === 'file' ? new Response('not found', { status: 404 }) : notBuilt()
  }
  const file = Bun.file(path)
  if (!(await file.exists())) {
    return resolved.kind === 'file' ? new Response('not found', { status: 404 }) : notBuilt()
  }
  return new Response(file)
}
