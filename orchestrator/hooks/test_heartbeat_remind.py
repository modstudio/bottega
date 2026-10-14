import importlib.util
import os
import unittest


PATH = os.path.join(os.path.dirname(__file__), "heartbeat-remind.py")
SPEC = importlib.util.spec_from_file_location("heartbeat_remind", PATH)
heartbeat_remind = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat_remind)


class DetachedDispatchTest(unittest.TestCase):
    def test_recognizes_front_door_and_legacy_dispatch_spellings(self):
        self.assertIsNotNone(
            heartbeat_remind.detached_dispatch("bottega run start implement task")
        )
        self.assertIsNotNone(
            heartbeat_remind.detached_dispatch("/opt/bin/orch do implement task")
        )

    def test_following_dispatch_does_not_need_a_heartbeat(self):
        self.assertIsNone(
            heartbeat_remind.detached_dispatch("bottega run start implement task --follow")
        )
        self.assertIsNone(
            heartbeat_remind.detached_dispatch("orch do implement task --follow")
        )

    def test_ignores_removed_legacy_land_command(self):
        self.assertIsNone(heartbeat_remind.detached_dispatch("orch land DEV-1311"))


if __name__ == "__main__":
    unittest.main()
