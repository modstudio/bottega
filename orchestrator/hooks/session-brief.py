#!/usr/bin/env python3
"""SessionStart hook: operator brief, then any open resume briefs, for this checkout."""
import json
import os
import re
import subprocess
import sys
import time


def _start(orch, *args, env=None):
    return subprocess.Popen(
        [orch, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
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
        timeout = None if proc.poll() is not None else max(0, deadline - time.monotonic())
        stdout, _ = proc.communicate(timeout=timeout)
        return subprocess.CompletedProcess(proc.args, proc.returncode, stdout or "", _ or "")
    except Exception:
        _kill(proc)
        return subprocess.CompletedProcess(proc.args, -1, "", None)


def _resume_sentence(source, open_briefs):
    continuation = source in ("clear", "compact", "fork")
    if len(open_briefs) == 1:
        slug = open_briefs[0]["slug"]
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
        sid = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        orch = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "bin", "orch"))
        if not os.access(orch, os.X_OK):
            message = f"Inbox command is missing or not executable: {orch}; question state is unknown."
            sys.stdout.write(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": "",
                },
                "systemMessage": message,
            }) + "\n")
            return 0
        brief_p = _start(orch, "doc", "brief", "--cwd", cwd)
        resumes_p = _start(orch, "doc", "resumes", "--cwd", cwd, "--json")
        inbox_env = os.environ.copy()
        if sid:
            inbox_env["CLAUDE_CODE_SESSION_ID"] = sid
        inbox_p = _start(orch, "inbox", "--all", "--json", env=inbox_env)
        deadline = time.monotonic() + 10
        brief = _wait(brief_p, deadline)
        resumes = _wait(resumes_p, deadline)
        inbox = _wait(inbox_p, deadline)

        context = brief.stdout if brief.returncode == 0 else ""
        open_briefs = []
        lines = []
        unreadable = []
        resume_failure = None
        if resumes.returncode == 0:
            try:
                result = json.loads(resumes.stdout)
                if not isinstance(result, dict):
                    raise ValueError("invalid resume list JSON")
                raw_open = result.get("open")
                raw_unreadable = result.get("unreadable")
                if not isinstance(raw_open, list):
                    resume_failure = "Resume response was invalid; brief state is unknown."
                    raw_open = []
                for item in raw_open:
                    slug = item.get("slug") if isinstance(item, dict) else None
                    if (
                        isinstance(item, dict)
                        and isinstance(slug, str)
                        # Source of truth: docs.ts validateHistoricAddress. Slugs are 1-64
                        # lowercase letters, digits, or hyphens, starting alphanumeric.
                        and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", slug)
                        and isinstance(item.get("title"), str)
                        and isinstance(item.get("age"), str)
                    ):
                        open_briefs.append(item)
                    else:
                        resume_failure = "Resume response was invalid; brief state is unknown."
                if not isinstance(raw_unreadable, list):
                    resume_failure = "Resume response was invalid; brief state is unknown."
                    raw_unreadable = []
                for item in raw_unreadable:
                    if (
                        isinstance(item, dict)
                        and isinstance(item.get("slug"), str)
                        and item.get("reason") in ("no-frontmatter", "no-readable-status", "unrecognised-status")
                    ):
                        unreadable.append(item)
                    else:
                        resume_failure = "Resume response was invalid; brief state is unknown."
                lines = [
                    f'{item["slug"]:<24} {item["title"]:<24} {item["age"]}'
                    for item in open_briefs
                ]
            except Exception:
                resume_failure = "Resume response was invalid; brief state is unknown."
            if lines:
                if context and not context.endswith("\n"):
                    context += "\n"
                context += "\n".join(lines) + "\n"
                context += _resume_sentence(payload.get("source"), open_briefs) + "\n"
            if unreadable:
                if context and not context.endswith("\n"):
                    context += "\n"
                for item in unreadable:
                    context += (
                        f'UNREADABLE RESUME BRIEF `{item["slug"]}`: '
                        f'{item["reason"]}.\n'
                    )
        elif resumes.returncode == -1:
            resume_failure = "Resume observation timed out; brief state is unknown."
        else:
            first = next(
                (line.strip() for line in (resumes.stderr or "").splitlines() if line.strip()),
                None,
            )
            detail = f": {first}" if first else ""
            resume_failure = (
                f"Resume command failed with exit {resumes.returncode}{detail}; "
                "brief state is unknown."
            )

        answerable_count = foreign_count = unknown_count = 0
        inbox_failure = None
        if inbox.returncode == 0:
            try:
                questions = json.loads(inbox.stdout)
                if not isinstance(questions, list) or not all(
                    isinstance(item, dict)
                    and item.get("session_liveness") in ("live", "unknown")
                    and isinstance(item.get("can_answer"), bool)
                    for item in questions
                ):
                    raise ValueError("invalid inbox JSON")
                answerable_count = sum(item["can_answer"] for item in questions)
                foreign_count = len(questions) - answerable_count
                unknown_count = sum(
                    item["session_liveness"] == "unknown" for item in questions
                )
            except Exception:
                inbox_failure = "Inbox response was invalid; question state is unknown."
        elif inbox.returncode == -1:
            inbox_failure = "Inbox observation timed out; question state is unknown."
        else:
            inbox_failure = (
                f"Inbox command failed with exit {inbox.returncode}; question state is unknown."
            )

        notices = []
        if brief.returncode != 0:
            first = next((line.strip() for line in (brief.stderr or "").splitlines() if line.strip()),
                         None)
            if first:
                notices.append(f"operator brief refused: {first}")
        if inbox_failure:
            notices.append(inbox_failure)
        if resume_failure:
            notices.append(resume_failure)
        if answerable_count:
            noun = "question" if answerable_count == 1 else "questions"
            notices.append(f"{answerable_count} {noun} waiting on your ruling.")
        if foreign_count:
            noun = "question" if foreign_count == 1 else "questions"
            notices.append(
                f"{foreign_count} other-session {noun} visible; only their owners may rule."
            )
        if unknown_count:
            noun = "question" if unknown_count == 1 else "questions"
            verb = "has" if unknown_count == 1 else "have"
            notices.append(f"{unknown_count} visible {noun} {verb} unknown owner liveness.")
        if open_briefs:
            slugs = ", ".join(f"`{item['slug']}`" for item in open_briefs)
            noun = "brief" if len(open_briefs) == 1 else "briefs"
            notices.append(f"Open resume {noun}: {slugs}.")
        if unreadable:
            slugs = ", ".join(f"`{item['slug']}`" for item in unreadable)
            noun = "brief" if len(unreadable) == 1 else "briefs"
            notices.append(f"Unreadable resume {noun}: {slugs}.")

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
                if sid:
                    line = f"Arm under Monitor from the main checkout: {heartbeat} {sid}"
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
