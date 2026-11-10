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

The manifest allows Paseo 0.15.0 or later; the tested SDK and host are 0.15.3.
Compatibility with earlier 0.15.x releases has not been separately verified.
For OMP request rewriting, install the matching OMP extension as described in the README.
Other providers can supply display-only timeline rows. Hide and Summarize are enabled
only for a registered, compatible, enabled session adapter advertising that capability.
Existing hidden items can always be restored without an adapter. The panel distinguishes
missing adapters (with an installation hint), incompatible protocols, disabled adapters,
database failures and engine/runtime errors. Summarize queues work for the session
adapter's own model; Paseo never substitutes a separate model.

## Explorer and preview

Use Explorer's **+ → Session navigation**. The workspace panel follows the visible
session using chat/timeline identity matching every 1.5 seconds. Empty or unmatched
chats and non-session screens show **No session in view**. An optional picker pins an
agent; **Follow visible session** clears the pin. Paseo remembers open tabs and the
follow/pin choice. Closing the tab stays closed; there is no forced first-time opening.
Command Center's **Open session navigation** and **/nav** also open the agent panel.

Hide and Unhide retain rows in the outline. The read-only **Preview** drawer shows
original input/output or message text. Hidden tools show the stored **Sent to model**
replacement beside the originals, including pending-summary state; hidden messages
show **Removed from context**. Text previews are bounded to 8 KiB per payload with a
truncation marker. IDs and metadata remain selectable.

## Data access and limitations

The server runs SQLite away from its event loop in an embedded Node Worker. It reads
local session history and writes originals, replacements and hide state to
`~/.local/share/session-navigation/state.sqlite3`, or the XDG data location or
`SESSION_NAVIGATION_STATE_PATH` override. The adapter doing request rewriting must
use the same local state file; there is no cross-machine state synchronization.

Scopes come from persisted registrations and state, including zero-item registered
sessions. OMP binds to registered `omp:` scopes through explicit provider/session
metadata. Legacy `pi:` scopes are display/restore-only. Custom ACP providers bind to
published Hermes scopes with their explicit session/profile (`unknown` branch, with
legacy `default` discovery). Hermes mutable originals come from `adapter_targets`.
Manage requires explicit tool-call IDs; it never chooses cleanup targets automatically.

For source changes, run `npm ci`, `npm run build`, `npm run typecheck` and `npm test`
in `paseo-plugin/`. Commit the regenerated `server/worker-source.ts`; git-folder and
npm installations need neither sibling workspace packages nor a build tool at runtime.

The panel itself does not require an account or separate API key. Session-model
summarization may send the selected original tool output to the model provider
configured in the host. Local state storage does not mean all content stays local.
Measured tokens are shown only when available; missing measurements show a dash.
Destructive commands are excluded from automatic cleanup. Display-only rows remain
read-only, and unavailable chat history may prevent jumping to an outline item.
