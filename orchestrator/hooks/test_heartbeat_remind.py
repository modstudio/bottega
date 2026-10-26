import importlib.util
import os
import unittest


PATH = os.path.join(os.path.dirname(__file__), "heartbeat-remind.py")
SPEC = importlib.util.spec_from_file_location("heartbeat_remind", PATH)
heartbeat_remind = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat_remind)


class DetachedDispatchTest(unittest.TestCase):
    def test_recognizes_front_door_dispatch_spellings(self):
        self.assertIsNotNone(
            heartbeat_remind.detached_dispatch("bottega run start implement task")
        )

    def test_following_dispatch_does_not_need_a_heartbeat(self):
        self.assertIsNone(
            heartbeat_remind.detached_dispatch("bottega run start implement task --follow")
        )

    def test_board_question_needs_a_heartbeat(self):
        self.assertEqual(
            heartbeat_remind.detached_dispatch("bottega board ask --audience architects"),
            "board ask",
        )

    def test_only_request_posts_need_a_heartbeat(self):
        self.assertEqual(
            heartbeat_remind.detached_dispatch(
                "bottega board post --purpose request --audience architects"
            ),
            "board post request",
        )
        self.assertEqual(
            heartbeat_remind.detached_dispatch(
                "bin/bottega board post --purpose=request --audience architects"
            ),
            "board post request",
        )
        self.assertIsNone(
            heartbeat_remind.detached_dispatch(
                "bottega board post --purpose information --audience architects"
            )
        )

    def test_ack_required_defaults_a_post_to_request(self):
        self.assertEqual(
            heartbeat_remind.detached_dispatch(
                "bottega board post --ack-required --audience architects"
            ),
            "board post request",
        )
        self.assertIsNone(
            heartbeat_remind.detached_dispatch(
                "bottega board post --purpose information --ack-required --audience architects"
            )
        )

    def test_compound_command_finds_later_request(self):
        self.assertEqual(
            heartbeat_remind.detached_dispatch(
                "bottega run start implement task --follow && "
                "bottega board post --purpose request --audience architects"
            ),
            "board post request",
        )


if __name__ == "__main__":
    unittest.main()
