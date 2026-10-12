# Agent Sessions

Browse OMP and Claude Code sessions. A file opened from a session uses the comment view.

## Install

Download the `.vsix` from the [latest release](https://github.com/Zzz141592653/agent-sessions/releases/latest).

In Cursor, open the command palette, choose **Extensions: Install from VSIX…**, and pick that file. If `local.agent-sessions` is already installed, installing the new package replaces it.

## From source

Layout notes for later changes are in `AGENTS.md`. Changes are in `changelog.md`.

```bash
npm install
npm run package
```

`npm run package` writes `agent-sessions-<version>.vsix` in this directory. Install that file the same way.
