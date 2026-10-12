# Agent Sessions

Agent Sessions is a Cursor panel for the coding-agent conversations already on your machine. Open **Sessions: Open Session Library** and you can see which OMP and Claude Code sessions are still working, which ones just answered, and what they changed. You can reply, or comment on a file, without scrolling a terminal to find the right window.

It reads session files that OMP and Claude Code already write. It does not start those agents.

## See who still needs you

You start a few agents, switch to something else, and come back later. The library is the place that tells you where things stand.

![The session library, with one session still running, one new reply, the files that reply changed, and a follow-up ready to send.](docs/images/library.png)

- **Running** means that session's file is still growing.
- **New reply** means it has finished an answer and you have not opened it yet. A process that only exited does not count.
- Click **1 running** or **1 new**, or use **New reply** and **Running**, to see just those sessions.
- **This workspace** lists sessions for the repo you have open, including a folder inside it. A session started in a parent folder stays out. **All workspaces** shows the rest.
- Search matches titles. **Hide** tucks a session out of the main list. **Delete** is available after that session's window is closed, and it moves the record to the Trash.

The open session keeps updating while you read it, so you can watch a run that is still going. The list itself refreshes about once a minute, and also when a session file changes.

## Answer the session that just finished

The reply box is at the bottom of the open session. Write the follow-up there and press Enter, or **Send**.

For an OMP session whose window is still open, that text is pasted into that window. You do not have to find the terminal tab. Claude Code sessions can be read here. Sending a reply back is only available for OMP.

Under the transcript, **Files changed this turn** lists what that reply edited. **Diff** opens the change in the panel, split or inline, so you can check it before you answer.

## Comment on the passage, not the whole file

Open a file from a session and it uses the comment view. Select the sentence you mean, right-click, and choose **Comment**. The selection stays highlighted, and the comment box keeps the quote, so you can leave and come back without wondering which line you were writing about.

![A file opened from a session. One comment is already on a highlighted phrase, and a second comment is being written on a selection that stays highlighted.](docs/images/review.png)

**Send to this turn** pastes the comments from the review you are writing now. Comments from an earlier pass are not included.

A review closes when you send it. It also closes if you open the file again after its text has changed, which is what happens after the agent rewrites the file. The next review starts empty. The previous one stays in the **Review** menu, with its comments on the text from that pass. **View changes** diffs that pass against the file as it is now.

## Install

Download the `.vsix` from the [latest release](https://github.com/Zzz141592653/agent-sessions/releases/latest).

In Cursor, open the command palette, choose **Extensions: Install from VSIX…**, and pick that file. If `local.agent-sessions` is already installed, installing the new package replaces it.

To build from this repository:

```bash
npm install
npm run package
```

`npm run package` writes `agent-sessions-<version>.vsix` in this directory. Install that file the same way. Notes for changing the source are in `AGENTS.md`. Changes are in `changelog.md`.
