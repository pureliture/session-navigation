Session navigation adds a reversible context outline to Paseo's right-hand Explorer.
Browse user messages, assistant messages and tool results; hide or summarize supported
items, then restore them when needed. Original host history is not deleted: the host
adapter changes only the outgoing request copy. Hide is not a secret-erasure feature.

## Setup

The Paseo daemon must run Node **22.13 or later** (`node:sqlite`). Python and a separate
CLI are not required. The shared TypeScript engine and Node driver are embedded in a
worker-source artifact shipped with this plugin. Unsupported runtimes show an explicit
upgrade message rather than attempting to launch Python. The manifest's Node engine
metadata is informational on Paseo 0.15.3; the server enforces the runtime check.

The manifest requires Paseo 0.15.3 or later; versions `>=0.15.3` (including `0.16.x`
and newer) remain enabled automatically as long as runtime structural guards match.
Set top-level `pluginsEnabled: true` in the daemon configuration and restart it.
The OMP adapter requires Bun 1.4.4 or later; the Hermes adapter requires Hermes 0.20.1 or later.
For OMP request rewriting, install the matching OMP extension as described in the README.
Other providers can supply display-only timeline rows. Hide and Summarize are enabled
only for a registered, compatible, enabled session adapter advertising that capability.
Existing hidden items can always be restored without an adapter. The panel distinguishes
missing adapters (with an installation hint), incompatible protocols, disabled adapters,
database failures and engine/runtime errors. Summarize queues work for the session
adapter's own model; Paseo never substitutes a separate model.

## Explorer and preview

Use Explorer's **+ → Session navigation**. On web, the workspace panel follows the
visible session through tab/layout state and chat/timeline identity matching; empty or
non-session screens show **No session in view**. On mobile and native clients, it
follows Paseo `>=0.15.3` client focus updates within the current workspace and falls back
to a bound-session chooser when no session is focused or on pre-0.15.3 hosts.
Tapping a row on native clients opens its read-only **Preview** instead of scrolling
chat DOM. An optional picker pins an agent; **Follow visible session** clears the pin.
Paseo remembers open tabs and the follow/pin choice. Closing the tab stays closed;
there is no forced first-time opening. Command Center's **Open session navigation**
and **/nav** also open the agent panel.

Hide and Unhide retain rows in the outline. The read-only **Preview** drawer shows
original input/output or message text. Hidden tools show the stored **Sent to model**
replacement beside the originals, including pending-summary state; hidden messages
show **Removed from context**. Text previews are bounded to 8 KiB per payload with a
truncation marker. IDs and metadata remain selectable.

## Data access and limitations

### Subagents

The outline follows main sessions only. It does not render subagent child
rows, inline child outlines, or **Open tab** actions. Parent `delegate_task`
rows remain as ordinary tool rows with the parent's Hide/Unhide/Summarize
controls. Subagent scopes stay registered server-side for session binding,
but no subagent UI is offered.

Tab following and mobile focus tracking use guarded
**Paseo 0.15.3 UI/runtime internals**, isolated in `client/hostCompat.ts`. There is no
public SDK active-tab API in that version. Known untested versions fail
closed to manual session selection; if version metadata is
unavailable on web, strict DOM guards apply.

The server runs SQLite away from its event loop in an embedded Node Worker. It reads
local session history and writes originals, replacements and hide state to
`~/.local/share/session-navigation/state.sqlite3`, or the XDG data location or
`SESSION_NAVIGATION_STATE_PATH` override. The adapter doing request rewriting must
use the same local state file; there is no cross-machine state synchronization.

Scopes come from persisted registrations and state, including zero-item registered
sessions. OMP binds to registered `omp:` scopes through explicit provider/session
metadata. Legacy `pi:` scopes are display/restore-only. Custom ACP providers bind to
published Hermes scopes with their explicit session/profile (`unknown` branch, with
legacy `default` discovery). Local Hermes timelines and mutable tool records are read
directly from `~/.hermes/.../state.db` in read-only mode (`adapter_targets` and the ACP
timeline back up remote or unmapped sessions).
Manage requires explicit tool-call IDs; it never chooses cleanup targets automatically.

The npm package includes its worker and installs the pinned `yaml` runtime
dependency; neither a sibling workspace package nor Python is needed. A source
checkout needs its dependencies installed before loading the plugin.

The panel itself does not require an account or separate API key. Session-model
summarization may send the selected original tool output to the model provider
configured in the host. Local state storage does not mean all content stays local.
Measured tokens are shown only when available; missing measurements show a dash.
Destructive commands are excluded from automatic cleanup. Display-only rows remain
read-only, and unavailable chat history may prevent jumping to an outline item.
