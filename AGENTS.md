# Claude Code & OMP GUI (Agent Sessions)

Cursor extension. The command is "Sessions: Open Session Library". Version and publisher live in `package.json`.

This directory is the source. Installed copies live under `~/.cursor/extensions/*agent-sessions*`. Change behavior here, then package and reinstall.

## Before editing

Read the file you are about to change. Runtime code is split like this:

- `extension.js` — panel lifecycle, session list, activity state (`refreshSessionMeta` on `fs.watch` growth), replies, file diff, hide/Trash, mascot image picker (`mascotState`), and chat Mermaid script injection
- `sources.js` — incremental `headerCache` and transcript reader for OMP and Claude Code jsonl files, file-diff builder, `hasOmpProcess` (matches `omp`, `omp-*` custom builds, and path-prefixed binaries), and per-session/per-turn usage stats (`model`, `contextTokens`, `contextWindow` from `~/.omp/agent/models.yml`, `totalTokens`, `cost`, `todayCost`, `monthCost`, `turnCount`, `recentTurnCosts`)
- `review.js` — comment view for a file opened from a session, and `liveTty` + `pasteIntoTerminal` for OMP terminals
- `media/panel.js` and `media/panel.css` — session-library webview: unified time-sorted session list with leading `OMP` / `Claude` tags, chat Markdown + `<br>` table + Mermaid rendering (`media/mermaid.min.js`), and the draggable floating mascot widget (`#mascot-dock`)
- `media/mascot-omp.png`, `media/mascot-omp-idle.png`, `media/mascot-claude.png`, `media/mascot-claude-idle.png` — built-in thinking and idle expressions for OMP-tan and Claude-tan
- `media/fileview.js` and `media/fileview.css` — file-comment webview (`clearHighlights` updates `<mark class="comment-hit">` in place and preserves `docEl.scrollTop` when HTML is unchanged)
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

## Mascot widget & spend tracking

`#mascot-dock` floats over the panel (`position: fixed`, draggable via pointer events, coordinates persisted in `mascotPrefs`).

- **Character selection**: `auto` mode shows OMP-tan when an OMP session is selected and Claude-tan when a Claude Code session is selected. Right-clicking opens `#mascot-menu` (`Auto`, `Both`, `Claude-tan only`, `OMP-tan only`, custom local image picker via `pickMascotImage`, reset, minimize).
- **Thinking vs. idle expression**: Uses the thinking expression (`mascot-*-png`) while any session of that source is `running` (displaying running/new-reply counts in `.mascot-status`), and switches to the idle expression (`mascot-*-idle.png`) once `running === 0`.
- **Spend & per-call toasts**: Shows `Today` (turns with timestamp `>= local 00:00:00`) and `Month` (turns `>= 1st of month 00:00:00`) spend for that source. `.mascot-toast-stack` is a persistent DOM container (never cleared on `renderMascots()`); each new turn in `recentTurnCosts` spawns an independent `↑ +$0.xxx` `.spend-toast` (5s solid + 1.5s fade-out) and animates the `Today` counter via `animateSpendValue`.

## Package, install, and release

Every release ships to three targets: local Cursor, GitHub Releases (`Zzz141592653/claude-omp-gui`), and Open VSX (`jinxinyang.agent-sessions`).

1. Run `npm test` (`node --test`).
2. Update `docs/images/library.png` (`1280x800` @2x headless Chrome screenshot) if the library UI changed, and update `changelog.md` / `package.json` version when cutting a release.
3. Run `npm run package` to build `agent-sessions-<version>.vsix` (keep `.vsix` out of git).
4. Install into local Cursor:
   `/Applications/Cursor.app/Contents/Resources/app/bin/cursor --install-extension agent-sessions-<version>.vsix --force`
   and copy updated runtime/media files into `~/.cursor/extensions/*agent-sessions*/` so active unpacked folders stay in sync.
5. Push commits to `origin/main` and publish the GitHub release via `gh release create v<version> agent-sessions-<version>.vsix` (or `gh release upload v<version> ... --clobber`).
6. Publish to Open VSX (Cursor Marketplace) using the PAT in `~/open-vsx.token`:
   `npx ovsx publish agent-sessions-<version>.vsix -p "$(tr -d '[:space:]' < ~/open-vsx.token)"`
   and verify `curl -s "https://open-vsx.org/api/jinxinyang/agent-sessions" | jq -r .version` returns `<version>`, then delete the local `.vsix` artifact.
