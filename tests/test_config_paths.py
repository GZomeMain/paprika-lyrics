import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

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
            proc = self._git("check-ignore", "-q", name)
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


if __name__ == "__main__":
    unittest.main()