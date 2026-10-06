import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { FAKE_HARNESS_SCRIPT } from './fake-harness.ts'
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
  const fakeHarness = join(scratch, 'fake-harness')
  writeFileSync(fakeHarness, FAKE_HARNESS_SCRIPT)
  chmodSync(fakeHarness, 0o755)
  const containerScript = `set -eu
export DEBIAN_FRONTEND=noninteractive
export HOME=/tmp/empty-home
export BOTTEGA_INSTALL_DIR=/tmp/bin
export BOTTEGA_STATE_HOME=/tmp/state
export BOTTEGA_DOWNLOAD_BASE_URL=http://host.docker.internal:${port}/releases
export CLAUDE_CODE_SESSION_ID=DEV-1123-release-smoke
export ORCH_EMBED_URL=http://127.0.0.1:1/v1/embeddings
export ORCH_RERANK_URL=http://127.0.0.1:1/v1/rerank
mkdir -p "$HOME"
apt-get update >/dev/null
apt-get install -y --no-install-recommends ca-certificates curl >/dev/null
sh /install.sh
${installedBinary} --version
/tmp/bin/orch --version
/tmp/bin/orch jobs
/tmp/bin/hub task list
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"release-smoke","version":"1"}}}' | /tmp/bin/orch mcp | grep '"id":1'

doctor_output=$(/tmp/bin/orch doctor 2>&1)
printf '%s\\n' "$doctor_output"
printf '%s\\n' "$doctor_output" | grep -F 'ripgrep (rg) not found'
printf '%s\\n' "$doctor_output" | grep -F 'bubblewrap (bwrap) not installed'
printf '%s\\n' "$doctor_output" | grep -F 'socat not installed'

mkdir -p /tmp/bootstrap-bin /tmp/missing-deps-repository
printf '%s\\n' '#!/bin/sh' 'if [ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]; then printf "%s\\n" /tmp/missing-deps-repository; exit 0; fi' 'exit 1' > /tmp/bootstrap-bin/git
chmod 755 /tmp/bootstrap-bin/git
PATH=/tmp/bootstrap-bin:/tmp/bin:/usr/bin:/bin /tmp/bin/orch project add /tmp/missing-deps-repository --name missing-deps-smoke --allow-incomplete
set +e
probe_output=$(cd /tmp/missing-deps-repository && PATH=/tmp/bootstrap-bin:/tmp/bin:/usr/bin:/bin /tmp/bin/orch workflow probe -- git status --short 2>&1)
probe_status=$?
set -e
printf '%s\\n' "$probe_output"
test "$probe_status" -ne 0
printf '%s\\n' "$probe_output" | grep -F 'ripgrep (rg) not found'
printf '%s\\n' "$probe_output" | grep -F 'bubblewrap (bwrap) not installed'
printf '%s\\n' "$probe_output" | grep -F 'socat not installed'
if printf '%s\\n' "$probe_output" | grep -Fq 'bun install'; then
  echo 'missing-system-dependency remedy incorrectly named bun install' >&2
  exit 1
fi

apt-get install -y --no-install-recommends git sqlite3 ripgrep bubblewrap socat >/dev/null
git init --initial-branch=main /tmp/probe-repository >/dev/null
git -C /tmp/probe-repository config user.email smoke@example.invalid
git -C /tmp/probe-repository config user.name 'Release Smoke'
printf '%s\\n' 'release sandbox smoke' > /tmp/probe-repository/README.md
git -C /tmp/probe-repository add README.md
git -C /tmp/probe-repository commit -m 'DEV-1123 release smoke fixture' >/dev/null
useradd --create-home --shell /bin/sh smoke
mkdir -p /tmp/fake-bin /tmp/mcp-state /home/smoke/.codex
cp /fake-harness /tmp/fake-bin/codex
chmod 755 /tmp/fake-bin/codex
printf '%s\\n' '{}' > /home/smoke/.codex/auth.json
: > /home/smoke/.codex/config.toml
sqlite3 /tmp/state/orchestrator/orch.db "UPDATE agent SET caps=json_set(caps, '$.replyFile', json('true')), probed_at=datetime('now'), probe_result='{"ok":true,"source":"release smoke fixture"}' WHERE name='codex';"
chown -R smoke:smoke /tmp/state /tmp/probe-repository /tmp/mcp-state /home/smoke/.codex
su -s /bin/sh smoke -c '
  set -eu
  export HOME=/home/smoke
  export BOTTEGA_STATE_HOME=/tmp/state
  export CLAUDE_CODE_SESSION_ID=DEV-1123-release-smoke
  export ORCH_EMBED_URL=http://127.0.0.1:1/v1/embeddings
  export ORCH_RERANK_URL=http://127.0.0.1:1/v1/rerank
  export SMOKE_MCP_STATE=/tmp/mcp-state
  export PATH=/tmp/fake-bin:/tmp/bin:/usr/bin:/bin
  agent_output=$(/tmp/bin/orch agent list)
  printf "%s\\n" "$agent_output"
  printf "%s\\n" "$agent_output" | grep "^codex "
  printf "%s\\n" "$agent_output" | grep "^grok "
  cd /tmp/probe-repository
  /tmp/bin/orch project add /tmp/probe-repository --name release-smoke
  /tmp/bin/orch workflow probe -- git status --short
  /tmp/bin/orch do implement --agent codex --base main --follow --cwd /tmp/probe-repository "Make the release smoke fixture commit."
'
writing_worktree=$(cat /tmp/mcp-state/writing-worktree)
writing_hooks=$(cd "$writing_worktree" && git config --path core.hooksPath)
case "$writing_hooks" in
  "$writing_worktree"/*) echo "shared ref guard was installed inside writing worktree $writing_worktree" >&2; exit 1 ;;
esac
writing_branch=$(cat /tmp/mcp-state/writing-branch)
test "$(git -C /tmp/probe-repository log -1 --format=%s "$writing_branch")" = 'DEV-1091 guarded binary smoke'

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
      '--privileged',
      '--platform',
      `linux/${arch === 'arm64' ? 'arm64' : 'amd64'}`,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      `${join(import.meta.dir, '..', 'install.sh')}:/install.sh:ro`,
      '-v',
      `${fakeHarness}:/fake-harness:ro`,
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
