"""Tests for the media-session selection policy (core.session).

The policy is pure, so every rule about which player the overlay follows is
pinned here — including the two that real players broke:

* a pinned but idle app used to keep the overlay forever, so switching to
  another (playing) player left stale lyrics on screen;
* two tabs of one browser share a ``SourceAppUserModelId``, so identifying a
  session by app id alone could follow the paused tab while the other one played.
"""
import unittest

from core.session import HANDOVER_QUIET_S, select_session


def d(key, app_id=None, playing=False):
    return {
        "key": key,
        "app_id": key if app_id is None else app_id,
        "playing": playing,
    }


class SelectSessionTest(unittest.TestCase):
    def test_no_sessions_clears_everything(self):
        chosen, pin, challenger = select_session([], "A", ("A", 1.0), 100)
        self.assertIsNone(chosen)
        self.assertEqual(pin, "")
        self.assertIsNone(challenger)

    def test_the_best_session_is_taken_immediately_when_nothing_is_on_screen(self):
        descs = [d("A", playing=False), d("B", playing=True), d("C", playing=False)]
        chosen, pin, challenger = select_session(descs, "", None, 0)
        self.assertEqual(chosen, "B")
        self.assertEqual(pin, "B")
        self.assertIsNone(challenger)

    def test_playing_pin_keeps_the_overlay(self):
        # A second player starting must never steal a pin that is still playing.
        descs = [d("A", playing=True), d("B", playing=True)]
        chosen, pin, _ = select_session(descs, "A", None, 100)
        self.assertEqual(chosen, "A")
        self.assertEqual(pin, "A")

    def test_idle_pin_stays_when_nothing_else_plays(self):
        descs = [d("A", playing=False)]
        chosen, pin, _ = select_session(descs, "A", None, 100)
        self.assertEqual(chosen, "A")
        self.assertEqual(pin, "A")

    def test_idle_pin_relinquishes_to_a_playing_challenger(self):
        # The bug: pinned SimpMusic went idle while Spotify played, so the overlay
        # sat on a paused app. The challenger must earn the handover first.
        descs = [d("SimpMusic", playing=False), d("Spotify", playing=True)]
        chosen, pin, challenger = select_session(descs, "SimpMusic", None, 100)
        self.assertEqual(chosen, "SimpMusic")   # held while it earns it
        self.assertEqual(pin, "SimpMusic")
        self.assertEqual(challenger[0], "Spotify")

        chosen, pin, challenger = select_session(
            descs, pin, challenger, 100 + HANDOVER_QUIET_S)
        self.assertEqual(chosen, "Spotify")
        self.assertEqual(pin, "Spotify")
        self.assertIsNone(challenger)

    def test_a_challenger_that_goes_quiet_loses_its_progress(self):
        # A blip must not flick the lyrics onto another session.
        descs = [d("A", playing=False), d("B", playing=True)]
        _chosen, pin, challenger = select_session(descs, "A", None, 100)
        self.assertEqual(challenger[0], "B")

        # B stops playing: A keeps the overlay, and B has to earn the handover
        # again from scratch rather than resuming where it left off.
        then = [d("A", playing=False), d("B", playing=False)]
        chosen, pin, challenger = select_session(then, pin, challenger, 105)
        self.assertEqual(chosen, "A")
        self.assertEqual(pin, "A")
        self.assertIsNone(challenger)

        # Once B plays again for the whole quiet period, it wins.
        again = [d("A", playing=False), d("B", playing=True)]
        chosen, pin, challenger = select_session(again, pin, None, 106)
        self.assertEqual(chosen, "A")
        chosen, pin, _ = select_session(again, pin, challenger,
                                        106 + HANDOVER_QUIET_S)
        self.assertEqual(chosen, "B")
        self.assertEqual(pin, "B")

    def test_a_lost_pin_falls_through_to_reselection(self):
        descs = [d("B", playing=True)]
        chosen, pin, _ = select_session(descs, "A", ("A", 1.0), 100)
        self.assertEqual(chosen, "B")
        self.assertEqual(pin, "B")

    def test_the_same_app_is_preferred_among_playing_sessions(self):
        descs = [d("Other.exe\x01Song", app_id="Other.exe", playing=True),
                 d("browser\x01Song", app_id="browser", playing=True)]
        chosen, _pin, _ = select_session(descs, "", None, 0,
                                         pinned_app_id="browser")
        self.assertEqual(chosen, "browser\x01Song")

    def test_two_tabs_of_one_browser_follow_the_playing_tab(self):
        # The reported bug: "songs keep switching from yt music to another tab
        # which is not even playing". Both tabs share the browser's app id, so
        # only the session key tells them apart.
        songs_tab = d("msedge.exe\x01Song A", app_id="msedge.exe", playing=False)
        other_tab = d("msedge.exe\x01Other Video", app_id="msedge.exe", playing=True)

        chosen, pin, _ = select_session([songs_tab, other_tab], "", None, 0)
        self.assertEqual(chosen, other_tab["key"])
        self.assertEqual(pin, other_tab["key"])

        # And a paused tab must not displace the playing one it shares an app id
        # with, even when it is listed first.
        chosen, pin, _ = select_session([songs_tab, other_tab], other_tab["key"], None, 1)
        self.assertEqual(chosen, other_tab["key"])

        # A new song in the paused tab does not steal it either: the key changed,
        # but the session is idle and the challenger rule protects the playing pin.
        changed = d("msedge.exe\x01Song B", app_id="msedge.exe", playing=False)
        chosen, pin, _ = select_session([changed, other_tab], other_tab["key"], None, 2)
        self.assertEqual(chosen, other_tab["key"])

    def test_a_playing_same_browser_tab_takes_over_from_an_idle_one(self):
        yt = d("chrome.exe\x01Song", app_id="chrome.exe", playing=False)
        video = d("chrome.exe\x01Video", app_id="chrome.exe", playing=True)
        chosen, pin, challenger = select_session([yt], "chrome.exe\x01Song", None, 0)
        self.assertEqual(chosen, yt["key"])

        chosen, pin, challenger = select_session([yt, video], pin, None, 1)
        self.assertEqual(chosen, yt["key"])          # held while the challenger earns it
        chosen, pin, _ = select_session(
            [yt, video], pin, challenger, 1 + HANDOVER_QUIET_S)
        self.assertEqual(chosen, video["key"])
        self.assertEqual(pin, video["key"])

    def test_locked_source_wins_over_other_playing_session(self):
        # Even when Spotify and YouTube are both playing simultaneously,
        # locking to YouTube forces YouTube to be followed.
        spotify = d("spotify.exe\x01Song", app_id="spotify.exe", playing=True)
        youtube = d("chrome.exe\x01Video", app_id="chrome.exe", playing=True)
        chosen, pin, _ = select_session([spotify, youtube], "", None, 0, locked_key="chrome.exe")
        self.assertEqual(chosen, youtube["key"])
        self.assertEqual(pin, youtube["key"])

    def test_locked_source_stays_even_when_paused_while_another_plays(self):
        # A locked session stays selected even when paused while another session plays.
        spotify = d("spotify.exe\x01Song", app_id="spotify.exe", playing=False)
        youtube = d("chrome.exe\x01Video", app_id="chrome.exe", playing=True)
        chosen, pin, _ = select_session([spotify, youtube], "", None, 0, locked_key=spotify["key"])
        self.assertEqual(chosen, spotify["key"])
        self.assertEqual(pin, spotify["key"])

    def test_locked_source_falls_back_when_not_in_descriptors(self):
        # When the locked session is not running, falls back gracefully to standard arbitration.
        spotify = d("spotify.exe\x01Song", app_id="spotify.exe", playing=True)
        chosen, pin, _ = select_session([spotify], "", None, 0, locked_key="nonexistent.exe")
        self.assertEqual(chosen, spotify["key"])


if __name__ == "__main__":
    unittest.main()
