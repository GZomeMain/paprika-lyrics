import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

import config
from config import BASE_DIR, WEBVIEW_PROFILE_DIR


def _load_config_isolated(env_text: str, environ: dict | None = None) -> dict:
    """
    Imports a COPY of config.py with `.env` written beside it, in a subprocess.

    A copy rather than the real module: config.py reads the environment at import
    time, so the only honest way to test what it does with a given `.env` is to
    let it import fresh, with a `.env` that is not the developer's own. The real
    `.env` (which holds an API key) is never read, written or copied.
    """
    tmp = Path(tempfile.mkdtemp(prefix="spicy-config-test-"))
    try:
        shutil.copy2(BASE_DIR / "config.py", tmp / "config.py")
        if env_text is not None:
            (tmp / ".env").write_text(textwrap.dedent(env_text), encoding="utf-8")

        env = {k: v for k, v in os.environ.items() if not k.startswith("SPICY_")}
        env.update(environ or {})
        probe = (
            "import json, config;"
            "print(json.dumps({"
            "'base': str(config.BASE_DIR),"
            "'ttml': str(config.TTML_DIR),"
            "'webview': str(config.WEBVIEW_PROFILE_DIR),"
            "'key': config.SPICY_API_KEY,"
            "'ttl': config.CACHE_TTL_SECONDS,"
            "'debug': config.DEBUG,"
            "}))"
        )
        proc = subprocess.run([sys.executable, "-c", probe], cwd=tmp, env=env,
                              capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            raise AssertionError(f"config import failed:\n{proc.stdout}\n{proc.stderr}")
        import json
        return json.loads(proc.stdout.strip().splitlines()[-1])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class EnvFileLoadingTests(unittest.TestCase):
    """.env must actually configure the paths it advertises.

    The two path settings are read at import, *before* anything else, so the
    loader has to run ahead of them. When it ran after, `.env` was honoured for
    the API key but silently ignored for SPICY_TTML_DIR / SPICY_WEBVIEW_DIR —
    a setting the README tells the user to put in `.env`.
    """

    def test_env_file_sets_both_paths(self):
        out = _load_config_isolated("""
            SPICY_TTML_DIR=E:/Lyrics/ttml
            SPICY_WEBVIEW_DIR=E:/Temp/webview
        """)
        self.assertEqual(Path(out["ttml"]).as_posix(), "E:/Lyrics/ttml")
        self.assertEqual(Path(out["webview"]).as_posix(), "E:/Temp/webview")

    def test_env_file_still_sets_the_settings_it_already_did(self):
        # The regression guard for the fix: moving the loader must not cost the
        # settings that were already working.
        out = _load_config_isolated("""
            SPICY_API_KEY=key-from-file
            SPICY_CACHE_TTL_SECONDS=120
            SPICY_DEBUG=1
        """)
        self.assertEqual(out["key"], "key-from-file")
        self.assertEqual(out["ttl"], 120)
        self.assertTrue(out["debug"])

    def test_real_environment_outranks_the_file(self):
        out = _load_config_isolated(
            """
            SPICY_TTML_DIR=E:/from-file
            SPICY_WEBVIEW_DIR=E:/from-file
            SPICY_API_KEY=key-from-file
            """,
            environ={
                "SPICY_TTML_DIR": "E:/from-shell",
                "SPICY_WEBVIEW_DIR": "E:/from-shell",
                "SPICY_API_KEY": "key-from-shell",
            },
        )
        self.assertEqual(Path(out["ttml"]).as_posix(), "E:/from-shell")
        self.assertEqual(Path(out["webview"]).as_posix(), "E:/from-shell")
        self.assertEqual(out["key"], "key-from-shell")

    def test_a_missing_env_file_leaves_the_defaults(self):
        out = _load_config_isolated(None)
        # Relative to the copied config's own folder: the defaults are the
        # in-tree `ttml/` and `.webview/`, exactly as they are for the real one.
        base = Path(out["base"])
        self.assertEqual(Path(out["ttml"]), base / "ttml")
        self.assertEqual(Path(out["webview"]), base / ".webview")


class EnvQuoteHandlingTests(unittest.TestCase):
    """Wrapping quotes are stripped; quotes INSIDE a value are not."""

    def test_matching_wrapping_quotes_are_removed(self):
        out = _load_config_isolated("""
            SPICY_TTML_DIR="E:/Quoted/ttml"
            SPICY_WEBVIEW_DIR='E:/Quoted/webview'
        """)
        self.assertEqual(Path(out["ttml"]).as_posix(), "E:/Quoted/ttml")
        self.assertEqual(Path(out["webview"]).as_posix(), "E:/Quoted/webview")

    def test_internal_apostrophes_survive(self):
        # strip('"').strip("'") removed the trailing quote of "O'Brien" and left
        # a path that pointed at a folder that does not exist.
        out = _load_config_isolated("""
            SPICY_TTML_DIR="E:/Users/O'Brien/lyrics"
            SPICY_API_KEY='it's a key'
        """)
        self.assertEqual(Path(out["ttml"]).as_posix(), "E:/Users/O'Brien/lyrics")
        self.assertEqual(out["key"], "it's a key")

    def test_an_unmatched_quote_is_left_alone(self):
        # A lone quote is part of the value, not a wrapper around it.
        out = _load_config_isolated("SPICY_API_KEY=\"half-quoted\n")
        self.assertEqual(out["key"], '"half-quoted')


class FrozenPathTests(unittest.TestCase):
    """A PyInstaller build has two folders, and the write targets must not move.

    `BASE_DIR` used to be the answer to every path question, which works only
    while the app is a directory of source files. Frozen, PyInstaller unpacks
    the bundle into a temp directory that is DELETED on exit, so a cache, a
    WebView2 profile or a `.env` resolved against it would be rebuilt from
    nothing on every launch — the exact failure the persistent profile exists to
    prevent, with the user's settings as the casualty.
    """

    def test_running_from_source_keeps_one_folder(self):
        resource, data = config._resolve_dirs(False, None, Path("E:/app"))
        self.assertEqual(resource, Path("E:/app"))
        self.assertEqual(data, Path("E:/app"))

    def test_a_frozen_build_reads_from_the_bundle_and_writes_beside_the_exe(self):
        resource, data = config._resolve_dirs(
            True, "C:/Temp/_MEI12345", Path("C:/Temp/_MEI12345"),
            "E:/Games/PaprikaLyrics/PaprikaLyrics.exe")
        self.assertEqual(resource, Path("C:/Temp/_MEI12345"))
        self.assertEqual(data, Path("E:/Games/PaprikaLyrics"))

    def test_a_frozen_build_without_an_executable_falls_back_to_the_module(self):
        # Defensive: `sys.executable` is empty in an embedded interpreter, and
        # guessing a drive root from an empty path would be worse than the
        # module's own folder.
        resource, data = config._resolve_dirs(True, "C:/Temp/_MEI1", Path("C:/Temp/_MEI1"), None)
        self.assertEqual(resource, Path("C:/Temp/_MEI1"))
        self.assertEqual(data, Path("C:/Temp/_MEI1"))

    def test_the_ui_is_read_from_the_resource_dir_and_state_written_to_data(self):
        # The split only helps if the settings actually use it. Asserted against
        # the source because the real values are bound at import, before a test
        # can make the process look frozen.
        src = (BASE_DIR / "config.py").read_text(encoding="utf-8")
        self.assertIn("INDEX_HTML_PATH = UI_DIR / \"index.html\"", src)
        self.assertIn("UI_DIR = RESOURCE_DIR", src)
        for name in ("CACHE_FILE", "TTML_DIR", "WEBVIEW_PROFILE_DIR"):
            line = next(l for l in src.splitlines() if l.startswith(name))
            self.assertIn("DATA_DIR", line, f"{name} must be written beside the app")

    def test_the_ttml_library_uses_the_data_dir_for_its_gitignore(self):
        # The library writes a `.gitignore` when its folder is inside the app
        # folder; against the temp bundle that guard would never fire.
        src = (BASE_DIR / "core" / "ttml_library.py").read_text(encoding="utf-8")
        self.assertIn("DATA_DIR in self.directory.resolve().parents", src)


class WritableDataDirTests(unittest.TestCase):
    """A build dropped somewhere read-only must still be able to save.

    The portable zip writes beside the executable, which is correct when the
    user extracted it into their own folder and silently broken when it was
    unzipped under `C:\Program Files`: a standard user cannot create a file
    there, so the cache flush, the `.env` save and the WebView2 profile — every
    persistence guarantee the app makes — fail together. `_writable_data_dir` is
    the fallback, and its probe is injected so this is testable without a
    read-only volume.
    """

    def test_a_writable_folder_is_kept(self):
        target = Path("E:/Games/PaprikaLyrics")
        chosen, fell_back = config._writable_data_dir(target, probe=lambda d: True)
        self.assertEqual(chosen, target)
        self.assertFalse(fell_back)

    def test_an_unwritable_folder_falls_back_to_the_user_directory(self):
        target = Path("C:/Program Files/PaprikaLyrics")
        chosen, fell_back = config._writable_data_dir(target, probe=lambda d: d != target)
        self.assertEqual(chosen, config._fallback_data_dir())
        self.assertTrue(fell_back)

    def test_the_fallback_is_one_app_specific_folder_under_local_app_data(self):
        # %LOCALAPPDATA% is per-user and always writable, and the folder is ours
        # alone so another program's data cannot collide with our cache.
        with mock.patch.dict(os.environ,
                             {"LOCALAPPDATA": "E:/Users/Someone/AppData/Local"}):
            self.assertEqual(
                config._fallback_data_dir(),
                Path("E:/Users/Someone/AppData/Local/PaprikaLyrics"))

    def test_nothing_writable_keeps_the_preferred_folder(self):
        # Abandoning the user's chosen folder for one we cannot write either
        # would be a silent relocation, which is worse than a reported failure.
        target = Path("E:/Games/PaprikaLyrics")
        chosen, fell_back = config._writable_data_dir(target, probe=lambda d: False)
        self.assertEqual(chosen, target)
        self.assertFalse(fell_back)

    def test_a_probe_that_raises_is_treated_as_not_writable(self):
        # The probe touches the filesystem; it must not be able to take the
        # process down at import time if the drive disappears underneath it.
        def exploding(_directory):
            raise OSError("drive disconnected")

        target = Path("E:/Games/PaprikaLyrics")
        chosen, fell_back = config._writable_data_dir(target, probe=exploding)
        self.assertEqual(chosen, target)
        self.assertFalse(fell_back)

    def test_every_write_target_follows_the_resolved_data_dir(self):
        # The fallback only helps if the cache, the log and the rest derive from
        # DATA_DIR rather than rebuilding a path from BASE_DIR or the exe folder.
        src = (BASE_DIR / "config.py").read_text(encoding="utf-8")
        self.assertIn("DATA_DIR, DATA_DIR_IS_FALLBACK = _writable_data_dir(", src)
        self.assertIn('LOG_FILE = DATA_DIR / "logs" / "paprika.log"', src)

    def test_the_resolved_folder_is_reported_at_startup(self):
        # A "my settings vanish" report has to be answerable from the log, so the
        # startup line must name the folder and whether it was the fallback.
        src = (BASE_DIR / "paprika_app.py").read_text(encoding="utf-8")
        self.assertIn("data_dir=%s fallback=%s frozen=%s", src)


class CredentialGuardTests(unittest.TestCase):
    """
    Agent scratch directories hold live session tokens.

    `.gitignore` is the only thing keeping the session credential under
    `.superpowers/brainstorm/` out of the published tree, and an ignore file
    cannot untrack a file that is already in the index — `.freebuff/project-id`
    was committed exactly that way. This is the automated guard for it: both
    directories must be ignored, and neither may have a single tracked file.

    Deliberately does not name the credential file: this test is committed, and
    a path in a committed file is a map to the secret it is guarding.
    """

    SCRATCH_DIRS = (".superpowers", ".freebuff")

    def _git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=BASE_DIR,
                              capture_output=True, text=True, timeout=30)

    def test_the_repo_is_available_to_check(self):
        # A missing git (or a tarball checkout) would otherwise make every
        # assertion below vacuously pass.
        if self._git("rev-parse", "--git-dir").returncode != 0:
            self.skipTest("not a git working tree")

    def test_scratch_dirs_are_ignored(self):
        self.test_the_repo_is_available_to_check()
        for name in self.SCRATCH_DIRS:
            # The trailing slash is load-bearing: the rules are directory-only,
            # and on a fresh checkout neither directory exists — git can only
            # tell a path is a directory from the query itself. Without it a
            # correct .gitignore reads as "not covered" exactly where CI runs
            # this guard (verified: `check-ignore -q dir` fails for a missing
            # dir-only match, `dir/` succeeds in every case).
            proc = self._git("check-ignore", "-q", name + "/")
            self.assertEqual(proc.returncode, 0,
                             f"{name}/ is not covered by .gitignore")

    def test_no_scratch_file_is_tracked(self):
        self.test_the_repo_is_available_to_check()
        proc = self._git("ls-files", *self.SCRATCH_DIRS)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        tracked = [line for line in proc.stdout.splitlines() if line.strip()]
        self.assertEqual(
            tracked, [],
            "agent scratch files are tracked in git and would be published: "
            + ", ".join(tracked))


class UiPreviewRegressionWiringTests(unittest.TestCase):
    """The UI checks must be EXECUTED, not merely parsed.

    `tools/ui-preview-regression.js` holds the assertions for the overlay's
    layout, motion, transparency and air invariants, and for a long time the
    only thing CI did with it was `node --check` — so a broken invariant was
    indistinguishable from a passing one. The step that runs it is the fix, and
    this is what stops it being dropped again.
    """

    def _workflow(self) -> str:
        return (BASE_DIR / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    def test_ci_runs_the_checks(self):
        self.assertIn("node tools/run-ui-preview-regression.mjs", self._workflow())

    def test_the_runner_exists_and_is_syntax_checked(self):
        self.assertTrue((BASE_DIR / "tools" / "run-ui-preview-regression.mjs").is_file())
        self.assertIn("node --check tools/run-ui-preview-regression.mjs", self._workflow())

    def test_the_runner_reports_failures_through_its_exit_status(self):
        # The contract CI depends on: a non-zero status on any failed viewport.
        # Asserted against the source because the runner needs a browser.
        src = (BASE_DIR / "tools" / "run-ui-preview-regression.mjs").read_text(encoding="utf-8")
        self.assertIn("process.exit(1)", src)

    def test_the_checks_expose_their_failures_on_the_result(self):
        # They used to reach the console only, so a programmatic caller could
        # read a result that looked clean no matter what failed.
        src = (BASE_DIR / "tools" / "ui-preview-regression.js").read_text(encoding="utf-8")
        self.assertIn("result.problems = problems;", src)


class WebviewProfileDirTests(unittest.TestCase):
    """The WebView2 profile is what makes every UI setting persist.

    pywebview's private_mode default is True, which hands WebView2 a fresh temp
    user-data folder per launch, so localStorage dies with the window. Turning it
    off requires a durable folder, and that folder is tens of MB of cache — it
    must never be committed, and it must sit beside the app rather than in a
    shared profile that another pywebview app could read over file://.
    """

    def test_profile_dir_sits_beside_the_app(self):
        self.assertEqual(WEBVIEW_PROFILE_DIR.parent, BASE_DIR)

    def test_profile_dir_is_gitignored(self):
        ignored = (BASE_DIR / ".gitignore").read_text(encoding="utf-8")
        self.assertIn(f"{WEBVIEW_PROFILE_DIR.name}/", ignored)

    def test_window_is_started_with_a_persistent_profile(self):
        # Wiring that cannot be executed headlessly: private_mode=False alone is
        # not enough (it would fall back to ~/AppData/pywebview), and a
        # storage_path without it still runs WebView2 in-memory.
        src = (BASE_DIR / "paprika_app.py").read_text(encoding="utf-8")
        self.assertIn("private_mode=False", src)
        self.assertIn("storage_path=str(WEBVIEW_PROFILE_DIR)", src)


class SpicyApiKeyManagementTests(unittest.TestCase):
    """Verifies in-app configuration and persistence for the Spicy Lyrics API key."""

    def setUp(self):
        self._orig_env = os.environ.get("SPICY_API_KEY")
        self._orig_config_key = config.SPICY_API_KEY

    def tearDown(self):
        if self._orig_env is not None:
            os.environ["SPICY_API_KEY"] = self._orig_env
        else:
            os.environ.pop("SPICY_API_KEY", None)
        config.SPICY_API_KEY = self._orig_config_key

    def test_set_and_get_spicy_api_key(self):
        res = config.set_spicy_api_key("sl_sk_abcdef123456")
        self.assertTrue(res["ok"])
        self.assertTrue(res["key_set"])
        self.assertIn("sl_sk_", res["masked"])
        self.assertIn("3456", res["masked"])
        self.assertEqual(config.get_spicy_api_key(), "sl_sk_abcdef123456")
        self.assertEqual(os.environ.get("SPICY_API_KEY"), "sl_sk_abcdef123456")

    def test_clear_spicy_api_key(self):
        config.set_spicy_api_key("sl_sk_samplekey")
        res = config.set_spicy_api_key("")
        self.assertTrue(res["ok"])
        self.assertFalse(res["key_set"])
        self.assertEqual(res["masked"], "")
        self.assertEqual(config.get_spicy_api_key(), "")
        self.assertNotIn("SPICY_API_KEY", os.environ)


if __name__ == "__main__":
    unittest.main()