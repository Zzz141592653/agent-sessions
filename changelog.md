# 1.4.0

Since 1.3.0.

- This workspace no longer includes sessions from a parent directory.
- Comments belong to one review of a file. A new review starts empty, and sending uses only that review.
- The passage stays highlighted while its comment is being written.
- A process-exit record is no longer a new reply.
- Hidden sessions that are running or have a new reply stay in the list.
- The list can be filtered to new replies or running sessions.

# 1.3.0

Since 1.2.5.

## Sessions

- Reply from the bottom of the panel. The reply is sent to the open OMP window. Enter sends it.
- Files changed in the current turn can be compared side by side or inline.
- A session can be hidden. After its window is closed, the record can be moved to the Trash.
- Quoted blocks render as quotes, without showing the source `>` characters.
- A session that is still running stays "Running". It does not become "New reply" just because it was not opened.
- The open session updates incrementally. The session list scans on file changes instead of rereading the whole library.

## File comments

- After opening a file from a session, select text and right-click Comment. The highlight stores the position at the time of the selection.
- A comment can be sent to this turn, which pastes it into the open OMP window.
- Mermaid diagrams in Markdown are rendered. Move the pointer to the top edge of a diagram and Full screen appears at the top right.

## Inputs

- Cmd+A selects all text in the search box, the reply box, and the comment box.
