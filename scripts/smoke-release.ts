import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { parseBinaryTarget } from './build-binary.ts'
import { run } from './build-release.ts'
import {
  artifactName,
  buildReleaseArtifact,
  writeChecksumSet,
  writeReleaseManifest,
} from './build-release-artifacts.ts'
import { RELEASE_BUN_VERSION } from './release-config.ts'

const version = '0.1.0'
const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-release-smoke-`))

async function freePort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '0.0.0.0', resolve)
  })
  const address = reservation.address()
  const port = typeof address === 'object' && address ? address.port : undefined
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  )
  if (!port) throw new Error('could not reserve a release smoke port')
  return port
}

try {
  const dockerArch = await run(['docker', 'info', '--format', '{{.Architecture}}'])
  const arch =
    dockerArch === 'aarch64' || dockerArch === 'arm64'
      ? 'arm64'
      : dockerArch === 'x86_64' || dockerArch === 'amd64'
        ? 'x64'
        : dockerArch
  const target = parseBinaryTarget(`linux-${arch}`)
  const asset = artifactName(version, target)
  const archive = await buildReleaseArtifact(`v${version}`, scratch, target)
  writeChecksumSet(scratch, [archive])
  writeReleaseManifest(scratch, {
    version,
    commit: await run(['git', 'rev-parse', 'HEAD']),
    bunVersion: RELEASE_BUN_VERSION,
    artifacts: [asset],
  })

  const port = await freePort()
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port,
    fetch(request) {
      const name = basename(new URL(request.url).pathname)
      const path = name === 'SHA256SUMS' || name === asset ? join(scratch, name) : undefined
      return path ? new Response(Bun.file(path)) : new Response('not found', { status: 404 })
    },
  })
  const installedBinary = `/tmp/bin/${PLATFORM_SLUG}`
  const containerScript = `set -eu
export HOME=/tmp/empty-home
export BOTTEGA_INSTALL_DIR=/tmp/bin
export BOTTEGA_STATE_HOME=/tmp/state
export BOTTEGA_DOWNLOAD_BASE_URL=http://host.docker.internal:${port}/releases
mkdir -p "$HOME"
apt-get update >/dev/null
apt-get install -y --no-install-recommends ca-certificates curl >/dev/null
sh /install.sh
${installedBinary} --version
/tmp/bin/orch --version
/tmp/bin/orch jobs
/tmp/bin/hub task list
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"release-smoke","version":"1"}}}' | /tmp/bin/orch mcp | grep '"id":1'
rm /tmp/bin/hub
printf '#!/bin/sh\\necho preserved-hub\\n' > /tmp/bin/hub
chmod 755 /tmp/bin/hub
sh /install.sh
test "$(readlink /tmp/bin/orch)" = ${installedBinary}
test "$(/tmp/bin/hub)" = preserved-hub
echo 'second install preserved the protected hub path and ${PLATFORM_SLUG} orch symlink'
`
  console.log(`Docker release smoke (${target}) ran:`)
  console.log(containerScript.trim())
  try {
    const output = await run([
      'docker',
      'run',
      '--rm',
      '--platform',
      `linux/${arch === 'arm64' ? 'arm64' : 'amd64'}`,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      `${join(import.meta.dir, '..', 'install.sh')}:/install.sh:ro`,
      'debian:stable-slim',
      'sh',
      '-c',
      containerScript,
    ])
    console.log(output)
  } finally {
    server.stop(true)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
