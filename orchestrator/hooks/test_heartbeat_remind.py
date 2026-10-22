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


if __name__ == "__main__":
    unittest.main()
