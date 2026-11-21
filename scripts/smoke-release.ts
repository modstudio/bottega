import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { artifactName } from '../shared/release-artifacts.ts'
import { parseBinaryTarget } from './build-binary.ts'
import {
  buildReleaseArtifact,
  writeChecksumSet,
  writeReleaseManifest,
} from './build-release-artifacts.ts'
import { FAKE_HARNESS_SCRIPT } from './fake-harness.ts'
import { RELEASE_BUN_VERSION } from './release-config.ts'
import { run } from './release-support.ts'

const version = '0.1.0'
const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-release-smoke-`))
const VERIFY_RELEASE_PROBE_SCRIPT = `#!/bin/sh
set -eu
writing_worktree=$(cat /tmp/mcp-state/writing-worktree)
writing_hooks=$(cat /tmp/mcp-state/writing-hooks)
case "$writing_hooks" in
  "$writing_worktree"/*)
    echo "shared ref guard was installed inside writing worktree $writing_worktree" >&2
    exit 1
    ;;
esac
writing_branch=$(cat /tmp/mcp-state/writing-branch)
test "$(git -C /tmp/probe-repository log -1 --format=%s "$writing_branch")" = "DEV-1091 guarded binary smoke"
`

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
  const verifyReleaseProbe = join(scratch, 'verify-release-probe')
  writeFileSync(verifyReleaseProbe, VERIFY_RELEASE_PROBE_SCRIPT)
  chmodSync(verifyReleaseProbe, 0o755)
  const containerScript = `set -eux
exec 1>&2
export DEBIAN_FRONTEND=noninteractive
export HOME=/tmp/empty-home
export BOTTEGA_INSTALL_DIR=/tmp/bin
export BOTTEGA_STATE_HOME=/tmp/state
export BOTTEGA_DOWNLOAD_BASE_URL=http://host.docker.internal:${port}/releases
export CLAUDE_CODE_SESSION_ID=DEV-1123-release-smoke
export BOTTEGA_EMBED_URL=http://127.0.0.1:1/v1/embeddings
export BOTTEGA_RERANK_URL=http://127.0.0.1:1/v1/rerank
mkdir -p "$HOME"
apt-get update >/dev/null
apt-get install -y --no-install-recommends ca-certificates curl >/dev/null
sh /install.sh
${installedBinary} --version
${installedBinary} agent jobs
${installedBinary} task list
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"release-smoke","version":"1"}}}' | ${installedBinary} mcp serve | grep '"id":1'

doctor_output=$(${installedBinary} machine doctor 2>&1 || true)
printf '%s\\n' "$doctor_output"
printf '%s\\n' "$doctor_output" | grep -F 'ripgrep (rg) not found'
printf '%s\\n' "$doctor_output" | grep -F 'bubblewrap (bwrap) not installed'
printf '%s\\n' "$doctor_output" | grep -F 'socat not installed'

mkdir -p /tmp/bootstrap-bin /tmp/missing-deps-repository
printf '%s\\n' '#!/bin/sh' 'case " $* " in *" symbolic-ref --quiet --short HEAD "*) printf "%s\\n" main; exit 0 ;; esac' 'for arg in "$@"; do case "$arg" in --local-env-vars) printf "%s\\n" GIT_DIR; exit 0 ;; --show-toplevel) printf "%s\\n" /tmp/missing-deps-repository; exit 0 ;; esac; done' 'exit 1' > /tmp/bootstrap-bin/git
chmod 755 /tmp/bootstrap-bin/git
PATH=/tmp/bootstrap-bin:/tmp/bin:/usr/bin:/bin ${installedBinary} project add /tmp/missing-deps-repository --name missing-deps-smoke --allow-incomplete --settings '{"trunk":"main"}'
set +e
probe_output=$(cd /tmp/missing-deps-repository && PATH=/tmp/bootstrap-bin:/tmp/bin:/usr/bin:/bin ${installedBinary} workflow probe -- git status --short 2>&1)
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
cp -R /workflow-tree /tmp/probe-repository/.agents
git -C /tmp/probe-repository add README.md .agents
git -C /tmp/probe-repository commit -m 'DEV-1123 release smoke fixture' >/dev/null
git clone --bare /tmp/probe-repository /tmp/probe-origin.git >/dev/null
git -C /tmp/probe-repository remote add origin /tmp/probe-origin.git
git -C /tmp/probe-repository fetch origin
git -C /tmp/probe-repository remote set-head origin --auto
printf '%s\\n' '{"keyPrefixes":["DEV"],"trunk":"main","docs":{"protocol":"orch-docs"}}' > /tmp/release-smoke-settings.json
useradd --create-home --shell /bin/sh smoke
mkdir -p /tmp/fake-bin /tmp/mcp-state /home/smoke/.codex
cp /fake-harness /tmp/fake-bin/codex
chmod 755 /tmp/fake-bin/codex
printf '%s\\n' '{}' > /home/smoke/.codex/auth.json
: > /home/smoke/.codex/config.toml
sqlite3 /tmp/state/orchestrator/orchestrator.db "UPDATE agent SET caps=json_set(caps, '$.replyFile', json('true')), probed_at=datetime('now'), probe_result=json_object('ok', json('true'), 'source', 'release smoke fixture') WHERE name='codex';"
chown -R smoke:smoke /tmp/state /tmp/probe-repository /tmp/probe-origin.git /tmp/mcp-state /home/smoke/.codex
su -s /bin/sh smoke -c '
  set -eux
  export HOME=/home/smoke
  export BOTTEGA_STATE_HOME=/tmp/state
  export CLAUDE_CODE_SESSION_ID=DEV-1123-release-smoke
  export BOTTEGA_EMBED_URL=http://127.0.0.1:1/v1/embeddings
  export BOTTEGA_RERANK_URL=http://127.0.0.1:1/v1/rerank
  export SMOKE_MCP_STATE=/tmp/mcp-state
  export PATH=/tmp/fake-bin:/tmp/bin:/usr/bin:/bin
  agent_output=$(${installedBinary} agent list)
  printf "%s\\n" "$agent_output"
  printf "%s\\n" "$agent_output" | grep "^codex "
  printf "%s\\n" "$agent_output" | grep "^grok "
  cd /tmp/probe-repository
  project_add_output=$(${installedBinary} project add /tmp/probe-repository --name release-smoke)
  printf "%s\\n" "$project_add_output"
  printf "%s\\n" "$project_add_output" | grep -F "trunk main (from origin/HEAD)"
  ${installedBinary} project set release-smoke --stack git --settings "$(cat /tmp/release-smoke-settings.json)"
  confinement_output=$(${installedBinary} review confinement report 2>&1)
  printf "%s\\n" "$confinement_output"
  printf "%s\\n" "$confinement_output" | grep -F "filesystem-probe  extracted ref guard executes under the area deny  committed"
  printf "%s\\n" "$confinement_output" | grep -F "filesystem-probe  goose  denied" | grep -F "${PLATFORM_SLUG} task show <probe task>=ran"
  printf "%s\\n" "$confinement_output" | grep -F "filesystem-probe  grok  denied" | grep -F "${PLATFORM_SLUG} task show <probe task>=ran"
  printf "%s\\n" "$confinement_output" | grep -F "filesystem-probe  ACP writer  denied" | grep -F "${PLATFORM_SLUG} task show <probe task>=ran"
  printf "%s\\n" "$confinement_output" | grep -F "filesystem-probe  workflow probe  denied" | grep -F "${PLATFORM_SLUG} task show <probe task>=ran" | grep -F "loopback listen+connect=ran" | grep -F "non-loopback outbound=ran"
  printf "%s\\n" "$confinement_output" | grep -F "filesystem-probe  cross-project CLI  ran" | grep -F "${PLATFORM_SLUG} task show <probe task>=ran"
  ${installedBinary} workflow import --cwd /tmp/probe-repository --reason "DEV-2421 release smoke workflow"
  ${installedBinary} workflow promote-tree --cwd /tmp/probe-repository --reason "DEV-2421 release smoke workflow"
  smoke_task=$(${installedBinary} task new --project release-smoke --title "Verify installed release")
  compose_output=$(${installedBinary} workflow compose verify-release --project release-smoke --arg key="$smoke_task" 2>&1)
  printf "%s\\n" "$compose_output"
  cursor=$(printf "%s\\n" "$compose_output" | sed -n "s/.*Cursor \\([0-9][0-9]*\\) was opened for workflow verify-release .*/\\1/p")
  case "$cursor" in
    ""|*[!0-9]*) echo "workflow compose did not report exactly one verify-release cursor number" >&2; exit 1 ;;
  esac
  printf "%s\\n" "$cursor" > /tmp/mcp-state/workflow-cursor
  printf "%s\\n" "$smoke_task" > /tmp/mcp-state/smoke-task
  ${installedBinary} workflow next --cursor "$cursor" --artifact "task:$smoke_task" --note "Probe repository and smoke task created."
  ${installedBinary} workflow probe -- git status --short
  dispatch_output=$(${installedBinary} workflow dispatch implement --cursor "$cursor" --agent codex "Make the release smoke fixture commit." 2>&1)
  printf "%s\\n" "$dispatch_output"
  run_number=$(printf "%s\\n" "$dispatch_output" | sed -n "s/.*detached as run \\([0-9][0-9]*\\):.*/\\1/p")
  case "$run_number" in
    ""|*[!0-9]*) echo "workflow dispatch did not report exactly one detached run number" >&2; exit 1 ;;
  esac
  ${installedBinary} run wait "$run_number"
  ${installedBinary} run result "$run_number"
  ${installedBinary} score "$run_number" full right faithful --note "Release smoke read the writing probe result."
  ${installedBinary} workflow next --cursor "$cursor" --run "$run_number" --note "Writing probe completed."
'
su -s /bin/sh smoke -c '
  set -eux
  export HOME=/home/smoke
  export BOTTEGA_STATE_HOME=/tmp/state
  export CLAUDE_CODE_SESSION_ID=DEV-1123-release-smoke
  export PATH=/tmp/fake-bin:/tmp/bin:/usr/bin:/bin
  cd /tmp/probe-repository
  cursor=$(cat /tmp/mcp-state/workflow-cursor)
  smoke_task=$(cat /tmp/mcp-state/smoke-task)
  exec_output=$(${installedBinary} workflow exec -- /tmp/verify-release-probe 2>&1)
  printf "%s\\n" "$exec_output"
  exec_id=$(printf "%s\\n" "$exec_output" | sed -n "s/^exec \\([0-9][0-9]*\\) passed$/\\1/p")
  case "$exec_id" in
    ""|*[!0-9]*) echo "workflow exec did not report exactly one passed exec number" >&2; exit 1 ;;
  esac
  ${installedBinary} workflow next --cursor "$cursor" --artifact "exec:$exec_id" --note "Guard placement and run commit verified."
  ${installedBinary} task show "$smoke_task"
  ${installedBinary} workflow next --cursor "$cursor" --artifact "task:$smoke_task" --note "Release writing probe complete."
'

printf '%s\\n' 'preserve this unrelated file' > /tmp/bin/unrelated-file
sh /install.sh
test "$(cat /tmp/bin/unrelated-file)" = 'preserve this unrelated file'
set -- /tmp/bin/*
test "$#" -eq 2
test "$1" = /tmp/bin/${PLATFORM_SLUG}
test "$2" = /tmp/bin/unrelated-file
echo 'second install preserved an unrelated file and left only it and ${PLATFORM_SLUG}'
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
      '-v',
      `${verifyReleaseProbe}:/tmp/verify-release-probe:ro`,
      '-v',
      `${join(import.meta.dir, '..', '.agents')}:/workflow-tree:ro`,
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
