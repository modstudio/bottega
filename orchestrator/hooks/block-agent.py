#!/usr/bin/env python3
"""PreToolUse hook: prefer an external agent, which costs no Claude allotment
at all, over a Claude subagent, which costs the same pool as this session.

THE DENIAL HAS TO NAME A ROUTE THAT EXISTS. For most of this gate's life every
job it could point at was read-only, so a session with implementation work to
delegate was denied and handed a menu with nothing on it that fit — leaving
"do it inline" or "try the spawn again" as the only moves. That is not a
compliance problem, it is a rule forbidding the only available path, and the
fix was to build the path rather than to word the refusal more firmly.

The accounting is not "subagents save nothing" - a subagent keeps its reading
out of the parent context, and the parent re-reads its context on every
remaining turn. Inlining 100 KB of reading into a long session is worse than a
subagent that reads it and returns 3 KB. The ordering that follows is:

  1. external agent, when one can do the job          - zero allotment
  2. Claude subagent, when none can (needs the web)   - costs once, not per turn
  3. inline reading                                    - costs on every later turn

So this denies (1)-shaped work and allows (2).

WEB WORK DECLARES ITSELF. Earlier this guessed from phrasing, which failed in
both directions: it denied "Research design-system doc practice" (genuine web
work) and then allowed the same task on its third rewording. A caller that
needs the network says so, in the prompt or description:

    NEEDS-WEB

Only the first 200 characters of either field are checked. A declaration has
to be part of the caller's request, not a quoted repository excerpt deep in it.

That is a declaration, not a lock. Anyone can write it, and the point is not to
prevent them - it is that writing it is deliberate and recorded, so a habit of
declaring web work that is not web work shows up in the log rather than hiding
in a regex.

A URL is NOT a declaration. It used to be, and that quietly restored the
rewording path this gate had just removed: any prompt quoting a docs link or a
stack trace was allowed, without anyone having decided it needed the network. A
URL is now recorded in the reason and nothing more.

EVERY DECISION IS LOGGED to the orchestrator's `spawn` table - allowed, denied,
and the tool calls this does not gate at all. Subagents are ~18% of Claude spend
here and none of it was attributable before; a gate that cannot report what it
let through cannot be tuned. A write that fails says so on stderr and falls back
to a sidecar log rather than vanishing.

Allowed through:
  - NEEDS-WEB in the first 200 characters of the prompt or description
  - subagent_type in ALLOW                   Claude-specific knowledge
  - ORCH_ALLOW_AGENT=1                       the human's override

DENIAL ONLY HAPPENS ON PreToolUse. SubagentStart cannot carry a permission
decision and has no prompt to judge, so it is audit-only.
"""
import json, os, re, sqlite3, sys, time

ALLOW = {"claude-code-guide"}

DB = os.environ.get("ORCH_DB") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "orch.db"
)
# Where a decision goes when sqlite will not take it. A gate that cannot say
# what it did is the thing this table exists to prevent, so a failed write has
# to leave a mark somewhere rather than evaporate.
FALLBACK_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "spawn-fallback.log")

# A declaration, not a vocabulary match. The old fuzzy list ("online", "docs",
# "benchmark", "pricing") is gone: it is what made rewording work.
DECLARED = re.compile(r"\bNEEDS[-_ ]?WEB\b", re.I)
URL = re.compile(r"https?://")


def session_id(payload):
    """Which session this is.

    The payload's own session_id first: it is what the event is actually about,
    and reading the environment instead attributed a spawn to whichever session
    happened to own this process.

    Then CLAUDE_CODE_SESSION_ID, which is always set and unique per session.
    CLAUDE_CODE_BRIDGE_SESSION_ID is last: it only exists while Remote Control is
    connected and is SHARED between sessions on the bridge, so preferring it
    filed runs under whichever session happened to share the connection.
    """
    return (
        (payload or {}).get("session_id")
        or os.environ.get("CLAUDE_CODE_SESSION_ID")
        or os.environ.get("CLAUDE_CODE_BRIDGE_SESSION_ID")
    )


def log(decision, why, inp, event, payload=None):
    """Record the decision. Never let logging break a session — but never let it
    disappear silently either.

    This used to be a bare `except: pass`, so a locked database produced a gate
    that still denied and a table that stayed empty, with nothing anywhere
    saying the two had come apart. A write that fails now says so on stderr
    (Claude shows it as a non-blocking hook error) and lands in a sidecar log,
    so the record survives the outage that broke it.

    The 5s connect timeout is raised to match orch's own busy_timeout: a spawn
    that arrives during a fan-out was being given a third of the patience the
    writers it is competing with have.
    """
    row = (
        time.strftime("%Y-%m-%dT%H:%M:%S"),
        session_id(payload),
        os.getcwd(),
        event,
        # PreToolUse calls it subagent_type; SubagentStart calls it agent_type.
        inp.get("subagent_type") or inp.get("agent_type"),
        (inp.get("description") or "")[:300],
        len(inp.get("prompt") or ""),
        decision,
        why,
    )
    try:
        # No CREATE TABLE here: orch owns the schema and creates it on open.
        # Taking a schema lock on every spawn only contended with the writers
        # this then had to wait for.
        db = sqlite3.connect(DB, timeout=15)
        db.execute("PRAGMA busy_timeout = 15000")
        db.execute(
            "INSERT INTO spawn (at, session_id, cwd, event, subagent_type,"
            " description, prompt_bytes, decision, why) VALUES (?,?,?,?,?,?,?,?,?)",
            row,
        )
        db.commit()
        db.close()
    except Exception as e:
        print(f"orch: spawn not logged ({e.__class__.__name__}: {e})", file=sys.stderr)
        try:
            with open(FALLBACK_LOG, "a") as fh:
                fh.write("\t".join("" if v is None else str(v) for v in row) + "\n")
        except Exception:
            pass  # out of places to put it; the stderr line is the last word


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(f"orch: hook payload could not be parsed ({e.__class__.__name__}: {e})", file=sys.stderr)
        try:
            row = (time.strftime("%Y-%m-%dT%H:%M:%S"), "payload could not be parsed")
            with open(FALLBACK_LOG, "a") as fh:
                fh.write("\t".join(row) + "\n")
        except Exception:
            pass  # stderr is the last fail-open record available
        return 0  # never block on a malformed payload

    # Two payload shapes reach here, and only ONE of them can deny.
    #
    # PreToolUse carries tool_name plus a tool_input object holding the
    # description and prompt, and it is the event that accepts a
    # permissionDecision. SubagentStart is a context event: it carries only
    # agent_id/agent_type, it has no prompt to read, and a permissionDecision in
    # its reply fails schema validation and blocks nothing. Emitting one there
    # produced a phantom `denied` row and a hook error beside a spawn that
    # started anyway. So SubagentStart is audit-only now.
    event = payload.get("hook_event_name")
    if event == "SubagentStart":
        log("seen", "subagent-start-audit", payload, event, payload)
        return 0
    if payload.get("tool_name") not in ("Agent", "Task"):
        # Recorded rather than dropped. Anything else that spawns agents —
        # Workflow above all, which fans out dozens — used to leave no trace at
        # all, so the expensive path was the invisible one.
        log("ignored", f"unmatched tool {payload.get('tool_name')!r}", payload.get("tool_input") or {}, event, payload)
        return 0
    inp = payload.get("tool_input") or {}

    declaration_fields = (
        str(inp.get("description") or "")[:200],
        str(inp.get("prompt") or "")[:200],
    )
    blob = "\n".join(str(inp.get(k) or "") for k in ("description", "prompt"))

    if os.environ.get("ORCH_ALLOW_AGENT") == "1":
        log("allowed", "env-override", inp, event, payload)
        return 0
    if inp.get("subagent_type") in ALLOW:
        log("allowed", "allowlist", inp, event, payload)
        return 0
    if any(DECLARED.search(field) for field in declaration_fields):
        log("allowed", "declared-web", inp, event, payload)
        return 0

    # A URL is evidence, not a declaration.
    #
    # It used to allow the spawn on its own, which made it the rewording path
    # this gate had already removed once: any file-reading prompt that happened
    # to quote a docs link, a stack trace, or a repo URL walked straight
    # through, without anyone deciding it needed the web. NEEDS-WEB is the
    # declaration, and the point of it is that writing it is a deliberate,
    # recorded act. So a URL is now only noted in the reason.
    log("denied", "delegable-with-url" if URL.search(blob) else "delegable", inp, event, payload)
    desc = (inp.get("description") or "").strip() or "this work"
    print(json.dumps({
        "hookSpecificOutput": {
            # Always PreToolUse: this is the only event that reaches here now,
            # and it is the only one whose schema accepts a permissionDecision.
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                f"An external agent costs no Claude allotment; a subagent costs this "
                f"session's. {desc!r} looks like work an external agent can do.\n\n"
                "YOUR ROLE: you are the architect, orchestrator and judge. You design "
                "the change, you rule on decisions, you review what comes back. The "
                "agents build.\n\n"
                "  orch do <job> \"<prompt>\"        # orch jobs - to see job types\n"
                "  orch do file-question --file /path/to/prompt.txt\n\n"
                "TO DELEGATE IMPLEMENTATION - this is not read-only work any more:\n"
                "  orch do implement \"<spec>\"      # writes, in a throwaway worktree\n"
                "  orch do fix \"<one change>\"      # a narrow, already-diagnosed change\n"
                "  orch inbox                       # design decisions a worker stopped to ask\n"
                "  orch answer <id> \"<ruling>\"     # rule, and resume it where it stopped\n"
                "  orch diff <id>                   # what it actually changed\n\n"
                "A worker escalates every design decision to you rather than guessing, "
                "so delegating implementation does not delegate the design.\n\n"
                "Then score it so routing improves:\n"
                "  orch score <id> <none|partial|full> [wrong|mixed|right] [drifted|partial|faithful]\n\n"
                "IF THIS NEEDS THE WEB, no external agent can do it - they have no "
                "network. Re-issue the same call with NEEDS-WEB in the prompt and it "
                "will be allowed. Say it only when it is true: every spawn is logged, "
                "and declaring web work that is not web work is visible in the log."
            ),
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
