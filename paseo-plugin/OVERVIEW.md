Session navigation panel for Paseo Explorer.

This plugin adds a workspace panel that lists recorded context items from the session-navigation SQLite store and lets you hide, summarize, unhide, re-hide, and manage them. Rows show status, tool or call id, measured token distribution, cost passthrough, and version. Actions use the shared SQLite store at ~/.local/share/session-navigation/state.sqlite3, or SESSION_NAVIGATION_STATE_PATH when set for tests.

Setup requires the session-navigation Python package and its CLI module on the daemon machine, plus a compatible Paseo daemon (0.15.0 or newer). The plugin invokes the session-navigation command line; if it is unavailable, handlers fall back to python -m session_navigation.cli. CAS conflicts return the current item so the list can refresh. Database errors surface a choice between aborting the request or sending originals.

Capabilities: list, hide, summarize, unhide, manage, and fork scope operations; per-item manage results; destructive commands are excluded from automatic manage. Summarization requires a session model and returns summarizer_unavailable when none is configured.