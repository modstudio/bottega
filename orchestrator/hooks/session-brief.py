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
        stderr=subprocess.DEVNULL,
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
        return subprocess.CompletedProcess(proc.args, proc.returncode, stdout or "", None)
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
                "fetch with get_doc only after they agree, then mark consumed with set_doc."
            )
        return (
            f"Open resume brief `{slug}`. Ask whether to load it before fetching with get_doc; "
            "do not consume it unless the operator agrees."
        )
    if continuation:
        return (
            "Open resume briefs above. Offer to resume from one of them; "
            "fetch with get_doc only after they agree, then mark consumed with set_doc."
        )
    return (
        "Open resume briefs above. Ask which (if any) to load before fetching with get_doc; "
        "do not consume unless they agree."
    )


def main() -> int:
    brief_p = resumes_p = None
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd")
        if not cwd:
            return 0
        orch = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "bin", "orch"))
        brief_p = _start(orch, "doc", "brief", "--cwd", cwd)
        resumes_p = _start(orch, "doc", "resumes", "--cwd", cwd)
        deadline = time.monotonic() + 10
        brief = _wait(brief_p, deadline)
        resumes = _wait(resumes_p, deadline)
        if brief.returncode == 0:
            sys.stdout.write(brief.stdout)
        if resumes.returncode != 0:
            return 0
        lines = [ln for ln in resumes.stdout.splitlines() if ln.strip()]
        if not lines:
            return 0
        if brief.returncode == 0 and brief.stdout and not brief.stdout.endswith("\n"):
            sys.stdout.write("\n")
        text = resumes.stdout
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
        sys.stdout.write(_resume_sentence(payload.get("source"), lines) + "\n")
    except Exception:
        pass
    finally:
        _kill(brief_p)
        _kill(resumes_p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
