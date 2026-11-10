Session navigation adds a reversible context outline to Paseo's right-hand Explorer.
Browse user messages, assistant messages and tool results; hide or summarize supported
items, then restore them when needed. Original host history is not deleted: the host
adapter changes only the outgoing request copy. Hide is not a secret-erasure feature.

## Setup

The session-navigation Python package and CLI must already be installed on the machine
running the Paseo daemon, with the CLI available to that daemon's environment. Python
3.11 or later is required. See the [project README](https://github.com/pureliture/session-navigation#installation)
for installation; the plugin does not download or install Python software for you.

The manifest allows Paseo 0.15.0 or later; the tested SDK and host are 0.15.3.
Compatibility with earlier 0.15.x releases has not been separately verified.
For OMP request rewriting, install the matching OMP extension as described in the README.
Other providers can supply display-only timeline rows; a visible row does not imply
that its provider supports context mutation. Summarization needs a compatible session
model; without one, it reports summarizer_unavailable.

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

The server launches the session-navigation CLI as a local child process. It reads
local session history and writes originals, replacements and hide state to
`~/.local/share/session-navigation/state.sqlite3`, or the XDG data location or
`SESSION_NAVIGATION_STATE_PATH` override. The adapter doing request rewriting must
use the same local state file; there is no cross-machine state synchronization.

The panel itself does not require an account or separate API key. Session-model
summarization may send the selected original tool output to the model provider
configured in the host. Local state storage does not mean all content stays local.
Measured tokens are shown only when available; missing measurements show a dash.
Destructive commands are excluded from automatic cleanup. Display-only rows remain
read-only, and unavailable chat history may prevent jumping to an outline item.
