/** Fake harness shared by compiled-binary and release-container smoke tests. */
export const FAKE_HARNESS_SCRIPT = `#!/bin/sh
harness="\${0##*/}"
smoke_root=$(dirname "$(dirname "$0")")
record="\${SMOKE_MCP_RECORD:-$smoke_root/mcp-argv.log}"
state="\${SMOKE_MCP_STATE:-$smoke_root/mcp-state}"
printf '%s' "$harness" >> "$record"
for arg in "$@"; do printf '\\t%s' "$arg" >> "$record"; done
printf '\\n' >> "$record"
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  shift 2
  if [ "$1" = "--scope" ]; then shift 2; fi
  name="$1"
  shift
  if [ "$1" = "--" ]; then shift; fi
  command="$1"
  shift
  printf '%s\\n' "$command" > "$state/$harness-$name.command"
  printf '%s\\n' "$*" > "$state/$harness-$name.args"
  printf 'added %s\\n' "$name"
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then
  name="$3"
  if [ ! -f "$state/$harness-$name.command" ]; then
    if [ "$harness" = "codex" ]; then
      printf "Error: No MCP server named '%s' found.\\n" "$name" >&2
    else
      printf 'No MCP server named "%s". Configured servers: probe\\n' "$name" >&2
    fi
    exit 1
  fi
  IFS= read -r command < "$state/$harness-$name.command"
  IFS= read -r args < "$state/$harness-$name.args"
  if [ "$harness" = "codex" ]; then
    printf '{"transport":{"type":"stdio","command":"%s","args":[' "$command"
    separator=''
    for arg in $args; do printf '%s"%s"' "$separator" "$arg"; separator=','; done
    printf ']}}\\n'
  else
    printf 'Command: %s\\nArgs: [' "$command"
    separator=''
    for arg in $args; do printf '%s"%s"' "$separator" "$arg"; separator=','; done
    printf ']\\n'
  fi
  exit 0
fi
if [ "$harness" = "codex" ] && [ "$1" = "exec" ]; then
  output=''
  previous=''
  for arg in "$@"; do
    if [ "$previous" = "-o" ]; then output="$arg"; fi
    previous="$arg"
  done
  printf 'guarded binary commit\n' > binary-smoke.txt
  git add binary-smoke.txt
  git commit -m 'DEV-1091 guarded binary smoke'
  hooks=$(git config --path core.hooksPath)
  printf '%s\n' "$PWD" > "$state/writing-worktree"
  printf '%s\n' "$hooks" > "$state/writing-hooks"
  git branch --show-current > "$state/writing-branch"
  reply='{"status":"done","summary":"The guarded commit completed.","files_changed":["binary-smoke.txt"],"questions":null,"deviations":null,"blockers":null,"tests":null}'
  if [ -n "$output" ]; then printf '%s\n' "$reply" > "$output"; fi
  printf '%s\n' '{"type":"thread.started","thread_id":"binary-smoke-thread"}'
  printf '{"type":"item.completed","item":{"type":"agent_message","text":%s}}\n' "$reply"
  printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
  exit 0
fi
exit 0
`
