Session navigation panel for Paseo Explorer.

Open Explorer's **+ → Session navigation**. By default the outline follows the visible
session using the same 1.5-second chat/timeline identity matching as the agent panel.
When no session is visible or matches, it shows **No session in view**. The optional
picker can pin a workspace agent; **Follow visible session** clears the pin.
The workspace panel remembers its follow/pin mode and outline filter in the host's
persisted tab state. Paseo restores open Explorer tabs on reload and workspace
return: leave the tab open to keep the navigator available. Closing it stays closed.
For a panel bound directly to the current agent, **Cmd/Ctrl+K → Open session navigation**
and **/nav** remain available.

Paseo 0.15.3's + menu lists only workspace-context plugin panels, not agent panels.
This plugin registers both kinds; adding manifest name/icon alone does not affect
menu eligibility. There is no public default-open flag or agent-screen mount/focus
hook in this SDK. The plugin does not force-open tabs, modify host layout storage,
or use timeline transformations as navigation side effects. On a new workspace,
add the tab once; subsequent automatic restoration is Paseo's saved-layout behavior.

The Side Chat reference (`Moyf/paseo-sidechat`, e1ce602) registers an Explorer agent
panel in `client/ui-registration.ts:17–24`, opens it via slash commands and Command
Center (`:38,55,106`), and documents Ctrl+K in `README.md:10`. It has no auto-open hook
or workspace-panel registration, so it is also excluded from this host's + menu.
Its manifest adds display name/icon/media and Chinese translations; persistent UI
labels use `client/messages.ts` message references, and its clickable panel header
opens the associated agent (`client/panel.tsx:414–430`). Our existing outline header
already offers an Open agent chat button; labels currently remain English. The
new manifest supplies name/icon; promotional media and localization are not needed
to register panels.

Host evidence (installed `index-6d081709f695773992be027100d988c7.js`): line 18388
filters `workspacePanels` with `if("workspace"!==n.context)continue`, checks server
and location, and uses each contribution's title/icon. Line 16603 persists and
restores `layoutByWorkspace` and the Explorer pane ID under `workspace-layout-state`.
SDK evidence: `@getpaseo/plugin/dist/client/contracts.d.ts:79–89,142–180` defines
locations (`workspace`/`explorer`), panel metadata, and explicit `openPanel`; no
default-open option. `addSurface`/`addSidebarItem` are deprecated screen/sidebar
aliases, not always-mounted agent hooks. Timeline transformers (`:207–217`) receive
only an item and phase, not an agent/workspace screen lifecycle.

This plugin adds a workspace panel that lists recorded context items from the session-navigation SQLite store and lets you hide, summarize, unhide, re-hide, and manage them. Rows show status, tool or call id, measured token distribution, cost passthrough, and version. Actions use the shared SQLite store at ~/.local/share/session-navigation/state.sqlite3, or SESSION_NAVIGATION_STATE_PATH when set for tests.

Setup requires the session-navigation Python package and its CLI module on the daemon machine, plus a compatible Paseo daemon (0.15.0 or newer). The plugin invokes the session-navigation command line; if it is unavailable, handlers fall back to python -m session_navigation.cli. CAS conflicts return the current item so the list can refresh. Database errors surface a choice between aborting the request or sending originals.

Capabilities: list, hide, summarize, unhide, manage, and fork scope operations; per-item manage results; destructive commands are excluded from automatic manage. Summarization requires a session model and returns summarizer_unavailable when none is configured.