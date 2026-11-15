"""The notice-id transport rules the two monitor-notice delivery hooks share."""

import importlib.util
from pathlib import Path
import unittest


PATH = Path(__file__).with_name("notice_transport.py")
SPEC = importlib.util.spec_from_file_location("notice_transport", PATH)
notice_transport = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notice_transport)

HOSTED_ID = "01990000-0000-7000-8000-000000000099"


def monitor_notice(kind, label, detail=None, **extra):
    return {
        "kind": kind,
        "label": label,
        "detail": detail or f"detail for {label}",
        **extra,
    }


class MonitorLines(unittest.TestCase):
    def test_a_single_notice_keeps_its_existing_line(self):
        self.assertEqual(
            notice_transport.monitor_lines([
                monitor_notice("unscored-run", "run 7", "read and score it")
            ]),
            ["MONITOR unscored-run run 7: read and score it"],
        )

    def test_repeated_kinds_render_at_their_first_positions(self):
        notices = [
            monitor_notice("unscored-run", "run 1"),
            monitor_notice("terminal-close-out-held", "run 2"),
            monitor_notice("unscored-run", "run 3"),
            monitor_notice("terminal-close-out-held", "run 4"),
        ]

        self.assertEqual(
            notice_transport.monitor_lines(notices),
            [
                "MONITOR unscored-run for 2: run 1, run 3. run 1: detail for run 1",
                (
                    "MONITOR terminal-close-out-held for 2: run 2, run 4. "
                    "run 2: detail for run 2"
                ),
                "",
                "",
            ],
        )

    def test_group_labels_are_capped_and_name_the_omitted_count(self):
        notices = [
            monitor_notice("unscored-run", f"run {index}")
            for index in range(notice_transport.MONITOR_GROUP_LABEL_LIMIT + 3)
        ]

        lines = notice_transport.monitor_lines(notices)

        labels = ", ".join(
            f"run {index}" for index in range(notice_transport.MONITOR_GROUP_LABEL_LIMIT)
        )
        self.assertEqual(
            lines[0],
            (
                f"MONITOR unscored-run for 11: {labels} and 3 more. "
                "run 0: detail for run 0"
            ),
        )
        self.assertEqual(lines[1:], [""] * 10)

    def test_non_monitor_rows_are_not_grouped(self):
        notices = [
            monitor_notice("landing-refused", "landing:1", "LANDING-REFUSED one"),
            monitor_notice("landing-refused", "landing:2", "LANDING-REFUSED two"),
            monitor_notice("stalled-run", "run 3", suppressed=True),
        ]

        self.assertEqual(
            notice_transport.monitor_lines(notices),
            ["LANDING-REFUSED one", "LANDING-REFUSED two", ""],
        )


class TransportableNoticeId(unittest.TestCase):
    def test_an_ordinary_id_is_accepted(self):
        for notice_id in (
            "condition:1",
            "condition:007",
            "landing:" + HOSTED_ID,
            "board:" + HOSTED_ID,
            "landing:7",
            "board:7",
        ):
            with self.subTest(notice_id=notice_id):
                self.assertTrue(notice_transport.transportable_notice_id(notice_id))

    def test_every_control_character_del_and_comma_is_refused(self):
        for code in (*range(0x20), 0x7F, ord(",")):
            with self.subTest(code=hex(code)):
                self.assertFalse(
                    notice_transport.transportable_notice_id("board:7" + chr(code) + "9")
                )

    def test_the_empty_id_is_refused(self):
        self.assertFalse(notice_transport.transportable_notice_id(""))

    def test_a_non_string_id_is_refused(self):
        for value in (None, 7, ["board:7"], {"id": "board:7"}):
            with self.subTest(value=value):
                self.assertFalse(notice_transport.transportable_notice_id(value))


class RefusedNoticeName(unittest.TestCase):
    def test_a_refused_id_is_named_by_its_sanitized_text(self):
        self.assertEqual(
            notice_transport.refused_notice_name({"noticeId": "board:\x007"}, 0),
            "board: 7",
        )
        self.assertEqual(
            notice_transport.refused_notice_name({"noticeId": "board:8,9"}, 0),
            "board:8 9",
        )

    def test_the_empty_id_is_named_as_empty(self):
        self.assertEqual(
            notice_transport.refused_notice_name({"noticeId": ""}, 4),
            "(empty notice id)",
        )

    def test_a_missing_id_is_named_by_its_position(self):
        self.assertEqual(notice_transport.refused_notice_name({}, 2), "#3")
        self.assertEqual(notice_transport.refused_notice_name("not a row", 0), "#1")

    def test_an_id_that_is_not_a_string_is_named_by_its_json_form(self):
        self.assertEqual(notice_transport.refused_notice_name({"noticeId": 7}, 0), "7")
        self.assertEqual(
            notice_transport.refused_notice_name({"noticeId": ["board:7"]}, 0),
            '["board:7"]',
        )

    def test_a_long_id_is_reported_bounded(self):
        # refusedNoticeName in orchestrator/src/monitor/monitor-notices.ts bounds a
        # name the same way, so a refused id has one spelling whichever hook reports it.
        long_id = "board:" + "7" * 400
        name = notice_transport.refused_notice_name({"noticeId": long_id}, 0)
        self.assertEqual(name, long_id[:80])


class AcknowledgementRefusals(unittest.TestCase):
    def test_the_refusals_of_a_valid_report_are_rendered_with_their_reasons(self):
        stdout = (
            '{"acknowledged": ["condition:1"], "refused": ['
            '{"id": "other:7", "reason": "a notice id is <source>:<identifier>"},'
            '{"id": "landing:7", "reason": "a landing id is a version-7 UUID"}]}'
        )
        self.assertEqual(
            notice_transport.acknowledgement_refusals(stdout),
            [
                "other:7 (a notice id is <source>:<identifier>)",
                "landing:7 (a landing id is a version-7 UUID)",
            ],
        )

    def test_malformed_output_yields_no_refusals(self):
        for stdout in ("", "not json", "[1, 2", "null"):
            with self.subTest(stdout=stdout):
                self.assertEqual(notice_transport.acknowledgement_refusals(stdout), [])

    def test_a_report_without_a_refused_list_yields_no_refusals(self):
        for stdout in (
            '{"acknowledged": ["condition:1"]}',
            '{"refused": "other:7"}',
            '{"refused": {"id": "other:7"}}',
            '["other:7"]',
        ):
            with self.subTest(stdout=stdout):
                self.assertEqual(notice_transport.acknowledgement_refusals(stdout), [])

    def test_refused_entries_without_a_name_or_reason_still_render(self):
        self.assertEqual(
            notice_transport.acknowledgement_refusals(
                '{"refused": ["other:7", {"id": 7, "reason": null}, {}]}'
            ),
            ["#? (unspecified)", "#? (unspecified)"],
        )


if __name__ == "__main__":
    unittest.main()
