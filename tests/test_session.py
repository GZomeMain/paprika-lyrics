import unittest

from core.session import HANDOVER_QUIET_S, select_session


def d(app_id, playing=False, is_current=False, in_current=False):
    return {
        "app_id": app_id,
        "playing": playing,
        "is_current": is_current,
        "in_current": in_current,
    }


class SelectSessionTest(unittest.TestCase):
    """Regression: a paused pinned session used to keep the overlay forever,
    so switching to another (playing) player left stale lyrics on screen."""

    def test_no_sessions_clears_everything(self):
        chosen, pin, challenger = select_session([], "A", ("A", 1.0), 100)
        self.assertIsNone(chosen)
        self.assertEqual(pin, "")
        self.assertIsNone(challenger)

    def test_lone_session_takes_over_and_then_pins(self):
        descs = [d("A", playing=True)]
        chosen, pin, challenger = select_session(descs, "", None, 100)
        self.assertEqual(chosen, "A")
        self.assertEqual(pin, "")            # not pinned until the quiet period
        self.assertEqual(challenger, ("A", 100))

        chosen, pin, challenger = select_session(descs, pin, challenger, 103)
        self.assertEqual(chosen, "A")
        self.assertEqual(pin, "")            # still earning it
        self.assertEqual(challenger, ("A", 100))

        chosen, pin, challenger = select_session(
            descs, pin, challenger, 100 + HANDOVER_QUIET_S)
        self.assertEqual(chosen, "A")
        self.assertEqual(pin, "A")
        self.assertIsNone(challenger)

    def test_playing_pin_keeps_the_overlay(self):
        # A second app starting must never steal a pin that is still playing.
        descs = [d("A", playing=True, in_current=True), d("B", playing=True)]
        chosen, pin, challenger = select_session(descs, "A", None, 100)
        self.assertEqual(chosen, "A")
        self.assertEqual(pin, "A")
        self.assertIsNone(challenger)

    def test_idle_pin_relinquishes_to_a_playing_challenger(self):
        # The bug: pinned SimpMusic went idle while Spotify played. The pin must
        # be dropped and the challenger must earn the handover.
        descs = [
            d("SimpMusic", playing=False, is_current=True, in_current=True),
            d("Spotify", playing=True),
        ]
        chosen, pin, challenger = select_session(descs, "SimpMusic", None, 100)
        self.assertEqual(pin, "")            # pin relinquished
        self.assertEqual(chosen, "SimpMusic")  # keep following current briefly
        self.assertEqual(challenger[0], "Spotify")

        chosen, pin, challenger = select_session(
            descs, pin, challenger, 100 + HANDOVER_QUIET_S)
        self.assertEqual(chosen, "Spotify")
        self.assertEqual(pin, "Spotify")
        self.assertIsNone(challenger)

    def test_idle_pin_stays_when_nothing_else_plays(self):
        descs = [d("A", playing=False, in_current=True)]
        chosen, pin, challenger = select_session(descs, "A", None, 100)
        self.assertEqual(chosen, "A")
        self.assertEqual(pin, "A")

    def test_lost_pin_falls_through_to_reselection(self):
        descs = [d("B", playing=True)]
        chosen, pin, challenger = select_session(descs, "A", ("A", 1.0), 100)
        self.assertEqual(chosen, "B")
        self.assertNotEqual(pin, "A")

    def test_multiple_sessions_without_current_choose_a_playing_one(self):
        # The old fallback could return None here (overlay blanked while audio
        # played); it must always pick something.
        descs = [d("A", playing=False), d("B", playing=True), d("C", playing=False)]
        chosen, _pin, _ch = select_session(descs, "", None, 0)
        self.assertEqual(chosen, "B")

    def test_no_pin_holds_idle_current_until_challenger_earns_it(self):
        descs = [d("A", playing=False, in_current=True), d("B", playing=True)]
        chosen, pin, challenger = select_session(descs, "", None, 100)
        self.assertEqual(chosen, "A")          # hold current, no flicker
        self.assertEqual(pin, "")
        chosen, pin, _ch = select_session(
            descs, pin, challenger, 100 + HANDOVER_QUIET_S)
        self.assertEqual(chosen, "B")
        self.assertEqual(pin, "B")

    def test_current_idle_does_not_beat_a_playing_session(self):
        descs = [d("A", playing=False, is_current=True), d("B", playing=True)]
        chosen, _pin, _ch = select_session(descs, "", None, 0)
        self.assertEqual(chosen, "B")


if __name__ == "__main__":
    unittest.main()
