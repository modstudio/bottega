"""The notice-id transport rules every monitor-notice delivery hook shares.

The notice-id grammar belongs to the acknowledgement validator
(`markMonitorNoticesDelivered` in `orchestrator/src/monitor/monitor-notices.ts`),
which accepts what it accepts and names every id it refuses. A delivery hook passes
ids through and lets the acknowledgement judge them, so this module never learns a
source name or an identifier shape.

What a hook does own is transport: a notice row is tab-separated, the
acknowledgement list is comma-separated, and a shell cannot carry NUL, so an id
holding a control character, DEL or a comma cannot survive the trip unchanged and
would be acknowledged as a different id. Exactly that is refused here, by name, so
the heartbeat and the session-start hook cannot disagree about it.

Run as a script, this module renders the refusals in an acknowledgement's `--json`
result, one `<id> (<reason>)` entry per line, so a shell hook can read them without
carrying its own parser:

    python3 notice_transport.py refusals <acknowledgement.json
"""

import json
import re
import sys

# Every C0 control character, DEL and the comma that separates acknowledgement ids.
UNTRANSPORTABLE_NOTICE_ID = re.compile("[\x00-\x1f\x7f,]")

# How much of a refused id's text is ever named; the acknowledgement bounds a name
# the same way in `refusedNoticeName`.
REFUSED_NAME_MAX_CHARS = 80

# What an id that renders to nothing is called, matching `refusedNoticeName`.
EMPTY_NOTICE_ID_NAME = "(empty notice id)"


def transportable_notice_id(value):
    """Whether the notice row and the comma-separated acknowledgement list can carry this id."""
    return (
        isinstance(value, str)
        and value != ""
        and not UNTRANSPORTABLE_NOTICE_ID.search(value)
    )


def refused_notice_name(row, index):
    """What to call a refused id: its sanitized text, or the position it held.

    An id that is not a string has no text to report, so it is named by its position
    in the batch or by its JSON form. A name that renders empty is called empty.
    """
    token = row.get("noticeId") if isinstance(row, dict) else None
    if isinstance(token, str):
        text = token
    elif token is None:
        text = "#" + str(index + 1)
    else:
        text = json.dumps(token)
    name = UNTRANSPORTABLE_NOTICE_ID.sub(" ", text)
    if not name:
        return EMPTY_NOTICE_ID_NAME
    return name[:REFUSED_NAME_MAX_CHARS]


def acknowledgement_refusals(stdout):
    """The `<id> (<reason>)` entries the acknowledgement refused, from its `--json` result.

    Malformed output yields no entries: the refusal report is supplemental to
    delivery, and a hook that cannot read it still reports what it did.
    """
    try:
        result = json.loads(stdout)
    except Exception:
        return []
    refused = result.get("refused") if isinstance(result, dict) else None
    if not isinstance(refused, list):
        return []
    entries = []
    for item in refused:
        if not isinstance(item, dict):
            continue
        name = item.get("id") if isinstance(item.get("id"), str) else "#?"
        reason = item.get("reason") if isinstance(item.get("reason"), str) else "unspecified"
        entries.append(name + " (" + reason + ")")
    return entries


def main(argv):
    mode = argv[1] if len(argv) > 1 else "refusals"
    if mode != "refusals":
        print("unknown notice transport mode: " + mode, file=sys.stderr)
        return 2
    for entry in acknowledgement_refusals(sys.stdin.read()):
        print(entry)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
