# Agent Sessions

Cursor extension. The command is "Sessions: Open Session Library". Version and publisher live in `package.json`.

This directory is the source. The installed copy under `~/.cursor/extensions/local.agent-sessions-<version>/` is an unpacked VSIX. Change behavior here, then package and reinstall.

## Before editing

Read the file you are about to change. Runtime code is split like this:

- `extension.js` — panel, session list, activity state, replies, file diff, hide, and Trash
- `sources.js` — scan jsonl transcripts, parse turns and tool calls, build file-diff data
- `review.js` — comment view for a file opened from a session, and paste text into the OMP terminal
- `media/panel.js` and `media/panel.css` — session-library webview
- `media/fileview.js` and `media/fileview.css` — file-comment webview. Mermaid uses `media/mermaid.min.js` in the same directory

User-facing strings are English.

## Where sessions come from

`listSessions` lists OMP and Claude Code only. `listCursor` and `loadCursor` can parse Cursor transcripts, and they are not wired into the list yet.

- OMP: `~/.omp/agent/sessions` and `~/.omp/profiles/*/agent/sessions`. When `XDG_DATA_HOME` is set and `$XDG_DATA_HOME/omp` exists, also `$XDG_DATA_HOME/omp/sessions`
- Claude Code: `~/.claude/projects/**/*.jsonl`. Claude records that mirror an OMP session are skipped
- Cursor (not listed): `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`

The list marks `inWorkspace` when the session directory is the workspace directory or a directory inside it.

## Activity

A session whose file is still growing is `running`. After the size stays quiet for `QUIET_MS` (15 seconds), a session whose tail is a reply and which the user does not have open becomes `fresh`. Growth that contains no conversation record, such as a process-exit line, stays seen. The open session updates incrementally and is not marked fresh. Hidden sessions that are `running` or `fresh` stay in the list. The activity filter is Any, New reply, or Running. The library scans about every 60 seconds and also watches jsonl files with `fs.watch`.

## Replies and comments

The reply box and "Send to this turn" both call `pasteIntoTerminal`: find the live TTY for that OMP session and paste the text there. Claude and Cursor sessions have no such path.

A file comment belongs to one review of that file. The review closes when its comments are sent, and also when the file is opened again after the text has changed. The next review starts with no comments. Sending pastes only the open review. An earlier review keeps its comments and the file text from that review.

## Package

After dependencies are installed, `npm run package` writes `agent-sessions-<version>.vsix`. In the Cursor command palette, choose **Extensions: Install from VSIX…** and install over the existing `local.agent-sessions`. VSIX files stay out of git.
