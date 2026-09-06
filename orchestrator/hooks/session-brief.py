#!/usr/bin/env python3
"""SessionStart hook: operator brief, then any open resume briefs, for this checkout."""
import json
import os
import subprocess
import sys
import time


def _start(orch, *args):
    return subprocess.Popen(
        [orch, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _kill(proc):
    if proc is None or proc.poll() is not None:
        return
    proc.kill()
    try:
        proc.communicate()
    except Exception:
        pass


def _wait(proc, deadline):
    try:
        stdout, _ = proc.communicate(timeout=max(0, deadline - time.monotonic()))
        return subprocess.CompletedProcess(proc.args, proc.returncode, stdout or "", _ or "")
    except Exception:
        _kill(proc)
        return subprocess.CompletedProcess(proc.args, -1, "", None)


def _resume_sentence(source, lines):
    continuation = source in ("clear", "compact", "fork")
    if len(lines) == 1:
        slug = lines[0].split()[0]
        if continuation:
            return (
                f"Open resume brief `{slug}`. Offer to resume from it; "
                "fetch with get_doc only after they agree, then run orch doc consume."
            )
        return (
            f"Open resume brief `{slug}`. Ask whether to load it before fetching with get_doc; "
            "after they agree and it is loaded, run orch doc consume."
        )
    if continuation:
        return (
            "Open resume briefs above. Offer to resume from one of them; "
            "fetch with get_doc only after they agree, then run orch doc consume."
        )
    return (
        "Open resume briefs above. Ask which (if any) to load before fetching with get_doc; "
        "after they agree and one is loaded, run orch doc consume."
    )


def main() -> int:
    brief_p = resumes_p = inbox_p = None
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd")
        if not cwd:
            return 0
        orch = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "bin", "orch"))
        brief_p = _start(orch, "doc", "brief", "--cwd", cwd)
        resumes_p = _start(orch, "doc", "resumes", "--cwd", cwd)
        inbox_p = _start(orch, "inbox", "--all", "--json")
        deadline = time.monotonic() + 10
        brief = _wait(brief_p, deadline)
        resumes = _wait(resumes_p, deadline)
        inbox = _wait(inbox_p, deadline)

        context = brief.stdout if brief.returncode == 0 else ""
        lines = []
        if resumes.returncode == 0:
            lines = [ln for ln in resumes.stdout.splitlines() if ln.strip()]
            if lines:
                if context and not context.endswith("\n"):
                    context += "\n"
                text = resumes.stdout
                context += text if text.endswith("\n") else text + "\n"
                context += _resume_sentence(payload.get("source"), lines) + "\n"

        question_count = orphaned_count = 0
        if inbox.returncode == 0:
            try:
                questions = json.loads(inbox.stdout)
                if not isinstance(questions, list) or not all(
                    isinstance(item, dict) and isinstance(item.get("session_live"), bool)
                    for item in questions
                ):
                    raise ValueError("invalid inbox JSON")
                question_count = len(questions)
                orphaned_count = sum(not item["session_live"] for item in questions)
            except Exception:
                question_count = orphaned_count = 0

        notices = []
        if brief.returncode != 0:
            first = next((line.strip() for line in (brief.stderr or "").splitlines() if line.strip()),
                         None)
            if first:
                notices.append(f"operator brief refused: {first}")
        if question_count:
            if orphaned_count:
                noun = "question" if orphaned_count == 1 else "questions"
                verb = "needs" if orphaned_count == 1 else "need"
                notices.append(
                    f"{orphaned_count} orphaned {noun} {verb} a ruling "
                    f"({question_count} total)."
                )
            else:
                noun = "question" if question_count == 1 else "questions"
                notices.append(f"{question_count} {noun} waiting on a ruling.")
        if lines:
            slugs = ", ".join(f"`{line.split()[0]}`" for line in lines)
            noun = "brief" if len(lines) == 1 else "briefs"
            notices.append(f"Open resume {noun}: {slugs}.")

        # Verify the heartbeat and hand over a ready-to-run Monitor command.
        # Do not launch it here: a hook cannot call Monitor, and backgrounding
        # it would send output nowhere while the session looked covered.
        # Compact/clear/fork already had their chance; re-handing is wallpaper.
        if payload.get("source") in ("startup", "resume"):
            heartbeat = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "orch-heartbeat.sh")
            )
            if not os.access(heartbeat, os.X_OK):
                msg = f"Heartbeat missing or not executable: {heartbeat}"
                if context and not context.endswith("\n"):
                    context += "\n"
                context += msg + "\n"
                notices.append(msg)
            else:
                # The payload's own session_id first, then the env var Claude always sets.
                sid = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
                if sid:
                    line = f"Arm under Monitor: {heartbeat} {sid}"
                    if context and not context.endswith("\n"):
                        context += "\n"
                    context += line + "\n"

        if not context and not notices:
            return 0
        output = {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context,
            }
        }
        if notices:
            output["systemMessage"] = " ".join(notices)
        sys.stdout.write(json.dumps(output) + "\n")
    except Exception:
        pass
    finally:
        _kill(brief_p)
        _kill(resumes_p)
        _kill(inbox_p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
