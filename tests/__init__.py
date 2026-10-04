"""Test package: pin the stdlib streams to UTF-8 before any test module loads.

The suite prints the app's emoji diagnostics straight to the real stdout, and on
a host whose ANSI codepage cannot encode them — cp1252 on the Windows CI runners
— that raises UnicodeEncodeError from inside tests that have nothing to do with
encoding (reproduced: ``PYTHONIOENCODING=cp1252`` fails exactly the way CI did).
What is under test is the message, not the console, so the console's codepage
must never decide the result. This mirrors the same pin in ``paprika_app.py``:
without it, a user redirecting the app's output into a file on a cp1252 machine
would lose the process to the first emoji printed.
"""

import sys

for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
