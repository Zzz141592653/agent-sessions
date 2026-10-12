# Agent Sessions

Cursor 扩展，命令是「Sessions: 打开会话库」。版本在 `package.json`。publisher 是 `local`。

这个目录是源码。本机已安装的副本在 `~/.cursor/extensions/local.agent-sessions-<version>/`，那是 VSIX 解出来的。改功能以这个仓库为准，改完再打包覆盖安装。

## 改之前

先读要动的文件。运行时分成三块：

- `extension.js` — 面板、会话列表、活动状态、回复、文件对比、隐藏和废纸篓
- `sources.js` — 扫描 jsonl，解析回合和工具调用，提供文件 diff 数据
- `review.js` — 从会话点开文件后的评论视图，以及把文字贴进 OMP 终端
- `media/panel.js`、`media/panel.css` — 会话库 webview
- `media/fileview.js`、`media/fileview.css` — 文件评论 webview。Mermaid 用同目录的 `mermaid.min.js`

界面文案是中文。

## 会话从哪来

`listSessions` 只列出 OMP 和 Claude Code。`listCursor` 和 `loadCursor` 已经能解析 Cursor 记录，还没有接到列表上。

- OMP：`~/.omp/agent/sessions`，以及 `~/.omp/profiles/*/agent/sessions`。若设置了 `XDG_DATA_HOME` 且存在 `$XDG_DATA_HOME/omp`，再加上 `$XDG_DATA_HOME/omp/sessions`
- Claude Code：`~/.claude/projects/**/*.jsonl`。和 OMP 镜像重复的 Claude 记录会跳过
- Cursor（未接入列表）：`~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`

列表按当前 workspace 标 `inWorkspace`。

## 活动状态

文件还在变大时，会话是 `running`（处理中）。大小安静超过 `QUIET_MS`（15 秒）后，若尾部是一轮回复、并且用户没有打开这条会话，变成 `fresh`（新回应）。打开着的会话只做增量更新，不标成新回应。整库大约每 60 秒扫一次，另外用 `fs.watch` 看 jsonl 变化。

## 回复和评论

底部回复和「发给这轮」都走 `pasteIntoTerminal`：找到这条 OMP 会话还活着的 TTY，把文字贴进那个终端。Claude 和 Cursor 会话没有这条路径。

文件评论的高亮记的是划选当时的位置，存在扩展的 `globalState`。

## 打包

依赖装好之后执行 `npm run package`，得到 `agent-sessions-<version>.vsix`。在 Cursor 命令面板里选 **Extensions: Install from VSIX…**，覆盖已有的 `local.agent-sessions`。VSIX 不进 git。
