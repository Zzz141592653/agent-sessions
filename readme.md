# Agent Sessions

浏览 OMP 和 Claude Code 会话。从会话里点开的文件用评论视图。

源码在这个仓库。给后续改动用的结构说明在 `AGENTS.md`。自 1.2.5 以来的变化在 `changelog.md`。

## 安装

```bash
npm install
npm run package
```

在 Cursor 里打开命令面板，选 **Extensions: Install from VSIX…**，选生成的 `agent-sessions-*.vsix`。已安装过 `local.agent-sessions` 时，直接装新包即可覆盖。
