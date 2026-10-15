const fs = require("fs");
const os = require("os");
const path = require("path");

const HEADER_BYTES = 48 * 1024;
const TOOL_OUTPUT_LIMIT = 6000;
const TURN_LIMIT = 240;
const META_PREFIXES = [
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<bash-stdout",
  "<bash-stderr",
  "<command-message>",
  "<user-memory-input>",
  "<task-notification",
];

const SOURCES = {
  omp: { id: "omp", label: "OMP" },
  claude: { id: "claude", label: "Claude Code" },
  cursor: { id: "cursor", label: "Cursor" },
};

const headerCache = new Map();
let modelCatalogCache = { mtimeMs: -1, map: new Map() };

const MARKER_ROLE_ASSISTANT = Buffer.from('"role":"assistant"');
const MARKER_TYPE_ASSISTANT = Buffer.from('"type":"assistant"');
const MARKER_MODEL_CHANGE = Buffer.from('"model_change"');
const MARKER_COST_STATE = Buffer.from('"cost-state"');
const MARKER_TITLE = Buffer.from('"title');
const MARKER_AI_TITLE = Buffer.from('"ai-title"');
function listSessions(workspacePaths) {
  const folders = (workspacePaths || []).map((folder) => path.resolve(folder));
  const seen = new Set();
  const sessions = [...listOmp(folders, seen), ...listClaude(folders, seen)];
  for (const filePath of headerCache.keys()) {
    if (!seen.has(filePath)) headerCache.delete(filePath);
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

function loadTranscript(filePath, source) {
  if (source === "omp") return loadOmp(filePath);
  if (source === "claude") return loadClaude(filePath);
  if (source === "cursor") return loadCursor(filePath);
  throw new Error(`Unknown source: ${source}`);
}

function listOmp(folders, seen) {
  const sessions = [];
  for (const root of ompRoots()) {
    for (const project of safeReaddir(root)) {
      const dir = path.join(root, project);
      if (!isDir(dir)) continue;
      for (const name of safeReaddir(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const filePath = path.join(dir, name);
        const meta = cachedHeader(filePath, seen, "omp", (entry, acc) => {
          if (entry.type === "session") {
            acc.cwd = entry.cwd || acc.cwd;
            acc.timestamp = entry.timestamp || acc.timestamp;
            if (!acc.title && entry.title) acc.title = entry.title;
          }
          if (!acc.preview && entry.type === "message" && entry.message?.role === "user") {
            acc.preview = clip(messageText(entry.message).replace(/\s+/g, " ").trim(), 140);
          }
          noteOmpUsage(acc, entry);
        });
        if (!meta) continue;
        sessions.push(summary("omp", filePath, meta, folders));
      }
    }
  }
  return sessions;
}

function listClaude(folders, seen) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const sessions = [];
  for (const project of safeReaddir(root)) {
    const dir = path.join(root, project);
    if (!isDir(dir)) continue;
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, name);
      const meta = cachedHeader(filePath, seen, "claude", (entry, acc) => {
        if (entry.isSidechain === true) acc.sidechain = true;
        if (!acc.cwd && entry.cwd) acc.cwd = entry.cwd;
        if (!acc.timestamp && entry.timestamp) acc.timestamp = entry.timestamp;
        if (!acc.preview && entry.type === "user") {
          const text = claudeUserText(entry);
          if (text && !isMetaText(text)) acc.preview = clip(text.replace(/\s+/g, " ").trim(), 140);
        }
        noteClaudeUsage(acc, entry);
      });
      if (!meta) continue;
      sessions.push(summary("claude", filePath, meta, folders));
    }
  }
  return sessions;
}

function cachedHeader(filePath, seen, source, visit) {
  seen.add(filePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const dayStart = currentDayStart();
  const cached = headerCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    if (cached.dayStart !== dayStart && cached.acc && !cached.acc.sidechain) {
      cached.meta = finalizeMeta(cached.acc, stat);
      cached.dayStart = dayStart;
    }
    return cached.meta;
  }
  if (source === "claude" && isOmpMirror(filePath)) {
    headerCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, offset: stat.size, dayStart, acc: null, meta: null });
    return null;
  }
  const prev = cached && cached.acc && stat.size > cached.offset ? cached : null;
  const scanned = scanSessionMeta(filePath, stat, source, visit, prev);
  if (!scanned) return null;
  const stored = !scanned.acc.sidechain ? finalizeMeta(scanned.acc, stat) : null;
  headerCache.set(filePath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset: scanned.offset,
    dayStart,
    acc: scanned.acc,
    meta: stored,
  });
  return stored;
}

function listCursor(folders) {
  const root = path.join(os.homedir(), ".cursor", "projects");
  const sessions = [];
  for (const project of safeReaddir(root)) {
    const transcripts = path.join(root, project, "agent-transcripts");
    if (!isDir(transcripts)) continue;
    const cwd = cwdForCursorProject(project, folders);
    for (const id of safeReaddir(transcripts)) {
      const sessionDir = path.join(transcripts, id);
      if (!isDir(sessionDir)) continue;
      const filePath = path.join(sessionDir, `${id}.jsonl`);
      if (!fs.existsSync(filePath)) continue;
      const meta = readHeader(filePath, (entry, acc) => {
        const role = entry.role;
        const message = entry.message;
        if (!acc.preview && role === "user" && message) {
          acc.preview = short(cleanUserText(messageText(message)), 140);
        }
      });
      if (!meta) continue;
      meta.cwd = cwd;
      if (!meta.title) meta.title = meta.preview || id;
      sessions.push(summary("cursor", filePath, meta, folders));
    }
  }
  return sessions;
}

function loadOmp(filePath) {
  return loadViaReader(filePath, "omp");
}

function loadClaude(filePath) {
  return loadViaReader(filePath, "claude");
}

function loadCursor(filePath) {
  return loadViaReader(filePath, "cursor");
}

function loadViaReader(filePath, source) {
  const reader = createTranscriptReader(filePath, source);
  readTranscript(reader);
  return snapshotTranscript(reader);
}

function createTranscriptReader(filePath, source) {
  const base = path.basename(filePath, ".jsonl");
  return {
    filePath,
    source,
    offset: 0,
    pending: Buffer.alloc(0),
    title: source === "omp" ? path.basename(filePath) : base,
    tools: new Map(),
    turns: [],
    patches: [],
    current: null,
    stamp: 0,
    filesStamp: -1,
    cachedFiles: [],
    cachedPatches: [],
    mtime: 0,
    usage: createUsageState(),
  };
}

function readTranscript(reader) {
  let stat;
  try {
    stat = fs.statSync(reader.filePath);
  } catch {
    return reader;
  }
  reader.mtime = stat.mtimeMs;
  if (stat.size < reader.offset) resetTranscript(reader);
  if (stat.size === reader.offset) return reader;
  const fd = fs.openSync(reader.filePath, "r");
  try {
    const len = stat.size - reader.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, reader.offset);
    reader.offset = stat.size;
    const data = reader.pending.length ? Buffer.concat([reader.pending, buf]) : buf;
    let start = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 10) continue;
      applyLine(reader, data.toString("utf8", start, index));
      start = index + 1;
    }
    reader.pending = start === 0 ? data : start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
  } finally {
    fs.closeSync(fd);
  }
  return reader;
}

function resetTranscript(reader) {
  const fresh = createTranscriptReader(reader.filePath, reader.source);
  Object.assign(reader, fresh);
}

function applyLine(reader, line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (reader.source === "omp") applyOmp(reader, entry);
  else if (reader.source === "claude") applyClaude(reader, entry);
  else if (reader.source === "cursor") applyCursor(reader, entry);
}

function applyOmp(reader, entry) {
  noteOmpUsage(reader.usage, entry);
  if ((entry.type === "title" || entry.type === "title_change") && entry.title) reader.title = entry.title;
  if (entry.type !== "message" || !entry.message) return;
  const message = entry.message;
  if (message.role === "user") {
    const text = messageText(message).trim();
    if (text) reader.turns.push({ role: "user", text: uniqueText(text) });
    return;
  }
  if (message.role === "assistant") {
    const turn = { role: "assistant", text: "", thinking: "", tools: [] };
    for (const block of contentBlocks(message.content)) {
      if (block.type === "thinking" && block.thinking) turn.thinking += String(block.thinking);
      else if (block.type === "text" && block.text) turn.text += (turn.text ? "\n\n" : "") + String(block.text);
      else if (block.type === "toolCall" && block.name) {
        const input = block.arguments ?? block.partialArgs;
        const tool = toolCard(SOURCES.omp.label, block.name, input, block.id);
        turn.tools.push(tool);
        rememberChange(reader, block.name, input, block.id);
        if (block.id) reader.tools.set(block.id, tool);
      }
    }
    if (turn.text || turn.thinking || turn.tools.length) reader.turns.push(turn);
    return;
  }
  if (message.role === "toolResult" && message.toolCallId) {
    const tool = reader.tools.get(message.toolCallId);
    if (!tool) return;
    tool.output = clip(messageText(message), TOOL_OUTPUT_LIMIT);
    setToolError(reader, tool, message.isError === true);
  }
}

function applyClaude(reader, entry) {
  noteClaudeUsage(reader.usage, entry);
  if (entry.type === "ai-title" && entry.aiTitle) reader.title = entry.aiTitle;
  if (entry.type === "assistant") {
    const message = entry.message || {};
    const id = message.id || "";
    if (!reader.current || reader.current.id !== id) {
      reader.current = { role: "assistant", id, text: "", thinking: "", tools: [] };
      reader.turns.push(reader.current);
    }
    for (const block of contentBlocks(message.content)) {
      if (block.type === "thinking" && block.thinking) reader.current.thinking += String(block.thinking);
      else if (block.type === "text" && block.text) reader.current.text += (reader.current.text ? "\n\n" : "") + String(block.text);
      else if (block.type === "tool_use" && block.name) {
        const tool = toolCard(SOURCES.claude.label, block.name, block.input, block.id);
        reader.current.tools.push(tool);
        rememberChange(reader, block.name, block.input, block.id);
        if (block.id) reader.tools.set(block.id, tool);
      }
    }
    return;
  }
  if (entry.type !== "user") return;
  const blocks = contentBlocks(entry.message?.content);
  const textParts = [];
  for (const block of blocks) {
    if (block.type === "tool_result") {
      const tool = reader.tools.get(block.tool_use_id);
      if (tool) {
        tool.output = clip(asText(block.content), TOOL_OUTPUT_LIMIT);
        setToolError(reader, tool, block.is_error === true);
      }
      continue;
    }
    if (block.text) textParts.push(String(block.text));
  }
  if (typeof entry.message?.content === "string") textParts.push(entry.message.content);
  const text = textParts.join("\n\n").trim();
  if (!text || isMetaText(text)) return;
  reader.current = null;
  reader.turns.push({ role: "user", text: uniqueText(text) });
}

function applyCursor(reader, entry) {
  const role = entry.role;
  if (role !== "user" && role !== "assistant") return;
  const blocks = contentBlocks(entry.message?.content);
  if (role === "user") {
    const text = visibleUserText(blocks.map((block) => block.text || "").join("\n\n"));
    if (!text) return;
    if (!reader.titled) {
      reader.title = short(text, 72);
      reader.titled = true;
    }
    reader.current = null;
    reader.turns.push({ role: "user", text: uniqueText(text) });
    return;
  }
  if (!reader.current) {
    reader.current = { role: "assistant", text: "", thinking: "", tools: [] };
    reader.turns.push(reader.current);
  }
  for (const block of blocks) {
    if (block.type === "text" && block.text) reader.current.text += (reader.current.text ? "\n\n" : "") + String(block.text);
    else if (block.type === "tool_use" && block.name) {
      reader.current.tools.push(toolCard(SOURCES.cursor.label, block.name, block.input, block.id));
      rememberChange(reader, block.name, block.input, block.id);
    }
  }
}

function visibleTurns(reader) {
  if (reader.source !== "claude") return reader.turns;
  return reader.turns.filter((turn) => turn.role === "user" || turn.text || turn.thinking || turn.tools?.length);
}

function snapshotTranscript(reader) {
  const turns = visibleTurns(reader);
  if (reader.filesStamp !== reader.stamp) {
    reader.cachedPatches = acceptedPatches(reader.patches, turns);
    reader.cachedFiles = summarizeFiles(reader.cachedPatches);
    reader.filesStamp = reader.stamp;
  }
  const omitted = Math.max(0, turns.length - TURN_LIMIT);
  return {
    title: reader.title,
    omitted,
    files: reader.cachedFiles,
    patches: reader.cachedPatches,
    stats: resolveStats(reader.usage, reader.mtime),
    turns: omitted ? turns.slice(turns.length - TURN_LIMIT) : turns.slice(),
  };
}

function rememberChange(reader, name, input, id) {
  const before = reader.patches.length;
  collectChanges(reader.patches, name, input, id);
  if (reader.patches.length !== before) reader.stamp += 1;
}

function setToolError(reader, tool, isError) {
  if (tool.isError === isError) return;
  tool.isError = isError;
  reader.stamp += 1;
}

function acceptedPatches(patches, turns) {
  const failed = new Set();
  for (const turn of turns) {
    for (const tool of turn.tools || []) {
      if (tool.isError && tool.id) failed.add(tool.id);
    }
  }
  return patches.filter((patch) => !patch.id || !failed.has(patch.id));
}

function summarizeFiles(patches) {
  const byPath = new Map();
  for (const patch of patches) {
    const stat = countChange(patch.before, patch.after);
    const prev = byPath.get(patch.path) || { path: patch.path, additions: 0, deletions: 0 };
    prev.additions += stat.additions;
    prev.deletions += stat.deletions;
    byPath.delete(patch.path);
    byPath.set(patch.path, prev);
  }
  return [...byPath.values()].reverse();
}

function collectChanges(patches, name, input, id) {
  for (const change of changesOf(name, parseInput(input))) {
    patches.push({ id: id || "", ...change });
  }
}

function changesOf(name, input) {
  const key = String(name).toLowerCase().replace(/[_-]/g, "");
  const target = filePathOf(name, input);
  if (!target || !isEditedPath(target)) return [];
  if (key === "write") {
    const after = stringField(input, ["content"]);
    return after ? [{ path: target, kind: "write", before: "", after }] : [];
  }
  if (key === "edit" || key === "strreplace" || key === "searchreplace") {
    const before = stringField(input, ["old_string", "old_str"]);
    const after = stringField(input, ["new_string", "new_str"]);
    if (!before && !after) return [];
    return [{ path: target, kind: "edit", before, after }];
  }
  if (key === "multiedit" && Array.isArray(input.edits)) {
    return input.edits.flatMap((edit) => changesOf("edit", { ...edit, path: edit.path || target }));
  }
  return [];
}

function stringField(input, names) {
  for (const name of names) {
    if (typeof input[name] === "string") return input[name];
  }
  return "";
}

function countChange(before, after) {
  const lines = diffLines(before, after);
  return {
    additions: lines.filter((line) => line.type === "add").length,
    deletions: lines.filter((line) => line.type === "del").length,
  };
}

function buildFileDiff(patches, target) {
  const matched = (patches || []).filter((patch) => patch.path === target);
  let additions = 0;
  let deletions = 0;
  let editIndex = 0;
  const hunks = matched.map((patch) => {
    const lines = diffLines(patch.before, patch.after);
    additions += lines.filter((line) => line.type === "add").length;
    deletions += lines.filter((line) => line.type === "del").length;
    const title = patch.kind === "write" ? "Write" : `Edit ${++editIndex}`;
    const limit = 400;
    return {
      title,
      truncated: lines.length > limit,
      lines: lines.slice(0, limit),
    };
  });
  return { additions, deletions, hunks };
}

function diffLines(before, after) {
  const oldLines = splitDiffLines(before);
  const newLines = splitDiffLines(after);
  if (!oldLines.length) return newLines.map((text) => ({ type: "add", text }));
  if (!newLines.length) return oldLines.map((text) => ({ type: "del", text }));
  if (oldLines.length * newLines.length > 250000) {
    return [
      ...oldLines.map((text) => ({ type: "del", text })),
      ...newLines.map((text) => ({ type: "add", text })),
    ];
  }
  const height = oldLines.length;
  const width = newLines.length;
  const scores = Array.from({ length: height + 1 }, () => new Uint32Array(width + 1));
  for (let row = height - 1; row >= 0; row -= 1) {
    for (let column = width - 1; column >= 0; column -= 1) {
      scores[row][column] = oldLines[row] === newLines[column]
        ? scores[row + 1][column + 1] + 1
        : Math.max(scores[row + 1][column], scores[row][column + 1]);
    }
  }
  const lines = [];
  let row = 0;
  let column = 0;
  while (row < height && column < width) {
    if (oldLines[row] === newLines[column]) {
      lines.push({ type: "ctx", text: oldLines[row] });
      row += 1;
      column += 1;
    } else if (scores[row + 1][column] >= scores[row][column + 1]) {
      lines.push({ type: "del", text: oldLines[row] });
      row += 1;
    } else {
      lines.push({ type: "add", text: newLines[column] });
      column += 1;
    }
  }
  while (row < height) lines.push({ type: "del", text: oldLines[row++] });
  while (column < width) lines.push({ type: "add", text: newLines[column++] });
  return lines;
}

function splitDiffLines(text) {
  if (!text) return [];
  const lines = String(text).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function isEditedPath(value) {
  if (!value || /[\r\n\0]/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  return true;
}

function toolCard(sourceLabel, name, input, id) {
  const parsed = parseInput(input);
  return {
    id: id || "",
    name: String(name),
    sourceLabel,
    command: commandOf(name, parsed),
    path: filePathOf(name, parsed),
    input: inputPreview(parsed),
    output: "",
    isError: false,
  };
}

function summary(source, filePath, meta, folders) {
  const info = SOURCES[source];
  const cwd = meta.cwd || "";
  const title = short(meta.title || meta.preview || path.basename(filePath, ".jsonl"), 72);
  return {
    key: `${source}:${filePath}`,
    source,
    sourceLabel: info.label,
    title,
    preview: meta.preview || "",
    cwd,
    project: cwd ? path.basename(cwd) : "",
    mtime: meta.mtime,
    size: meta.size || 0,
    model: meta.model || "",
    contextTokens: meta.contextTokens || 0,
    contextWindow: meta.contextWindow || 0,
    totalTokens: meta.totalTokens || 0,
    cost: meta.cost || 0,
    todayCost: meta.todayCost || 0,
    monthCost: meta.monthCost || 0,
    inWorkspace: belongsToWorkspace(cwd, folders),
    filePath,
  };
}

function createUsageState() {
  return {
    title: "",
    preview: "",
    cwd: "",
    timestamp: "",
    sidechain: false,
    model: "",
    contextTokens: 0,
    totalTokens: 0,
    cost: 0,
    turnCosts: [],
    msgTokens: null,
    msgSeq: 0,
    costStateTokens: 0,
    costStateUSD: 0,
    costStateTs: 0,
  };
}

function finalizeMeta(acc, stat) {
  const stats = resolveStats(acc, stat.mtimeMs);
  return {
    title: acc.title,
    preview: acc.preview,
    cwd: acc.cwd,
    timestamp: acc.timestamp,
    mtime: stat.mtimeMs,
    size: stat.size,
    sidechain: acc.sidechain,
    ...stats,
  };
}

function scanSessionMeta(filePath, stat, source, visit, prev) {
  const acc = prev ? prev.acc : createUsageState();
  const startOffset = prev ? prev.offset : 0;
  const len = stat.size - startOffset;
  if (len <= 0) return { acc, offset: startOffset };
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, startOffset);
    const slice = buf.subarray(0, n);
    let pos = 0;
    let consumed = startOffset;
    while (pos < slice.length) {
      const nl = slice.indexOf(10, pos);
      if (nl < 0) break;
      const lineBuf = slice.subarray(pos, nl);
      const absPos = startOffset + pos;
      pos = nl + 1;
      consumed = startOffset + pos;
      if (absPos >= HEADER_BYTES && !shouldParseMetaLine(source, lineBuf)) continue;
      const trimmed = lineBuf.toString("utf8").trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        visit(JSON.parse(trimmed), acc);
      } catch {
        // Skip a malformed line.
      }
    }
    return { acc, offset: consumed };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function shouldParseMetaLine(source, lineBuf) {
  if (source === "omp") {
    return lineBuf.includes(MARKER_ROLE_ASSISTANT) || lineBuf.includes(MARKER_MODEL_CHANGE) || lineBuf.includes(MARKER_TITLE);
  }
  if (source === "claude") {
    return lineBuf.includes(MARKER_COST_STATE) || lineBuf.includes(MARKER_TYPE_ASSISTANT) || lineBuf.includes(MARKER_AI_TITLE);
  }
  return false;
}

function noteOmpUsage(acc, entry) {
  if ((entry.type === "title" || entry.type === "title_change") && entry.title) acc.title = entry.title;
  if (entry.type === "model_change" && entry.model && entry.model !== "<synthetic>") acc.model = String(entry.model);
  if (entry.type !== "message" || entry.message?.role !== "assistant") return;
  const msg = entry.message;
  if (msg.model && msg.model !== "<synthetic>") {
    acc.model = msg.provider ? `${msg.provider}/${msg.model}` : String(msg.model);
  }
  const u = msg.usage;
  if (!u || typeof u !== "object") return;
  const inp = Number(u.input) || 0;
  const out = Number(u.output) || 0;
  const cr = Number(u.cacheRead) || 0;
  const cw = Number(u.cacheWrite) || 0;
  const tok = Number(u.totalTokens) || (inp + out + cr + cw);
  acc.totalTokens = (acc.totalTokens || 0) + tok;
  const promptTok = Number(msg.contextSnapshot?.promptTokens) || (inp + cr + cw);
  if (promptTok > 0) acc.contextTokens = promptTok;
  let turnCost = typeof u.cost?.total === "number" && u.cost.total > 0 ? u.cost.total : 0;
  if (!(turnCost > 0) && tok > 0) turnCost = estimateTurnCost(acc.model, inp, out, cr, cw);
  acc.cost = (acc.cost || 0) + turnCost;
  if (turnCost > 0) {
    acc.turnCosts.push({ ts: parseEntryTime(entry, msg), cost: turnCost });
  }
}

function noteClaudeUsage(acc, entry) {
  if (entry.type === "ai-title" && entry.aiTitle) acc.title = entry.aiTitle;
  if (entry.type === "assistant" && entry.message) {
    const msg = entry.message;
    const model = entry.requestedModel || msg.model;
    if (model && model !== "<synthetic>") acc.model = String(model);
    const u = msg.usage;
    if (!u || typeof u !== "object") return;
    const inp = Number(u.input_tokens) || 0;
    const out = Number(u.output_tokens) || 0;
    const cr = Number(u.cache_read_input_tokens) || 0;
    const cw = Number(u.cache_creation_input_tokens) || 0;
    const promptTok = inp + cr + cw;
    if (promptTok > 0) acc.contextTokens = promptTok;
    const tok = promptTok + out;
    if (tok > 0) {
      if (!acc.msgTokens) acc.msgTokens = new Map();
      const id = msg.id || entry.uuid || `seq:${++acc.msgSeq}`;
      const prev = acc.msgTokens.get(id);
      const ts = parseEntryTime(entry, msg) || prev?.ts || 0;
      acc.msgTokens.set(id, { model: acc.model, inp, out, cr, cw, tok, ts });
    }
    return;
  }
  if (entry.type === "cost-state") {
    if (typeof entry.totalCostUSD === "number" && entry.totalCostUSD > 0) {
      acc.costStateUSD = entry.totalCostUSD;
      acc.costStateTs = parseEntryTime(entry) || acc.costStateTs || 0;
    }
    let tot = 0;
    let bestModel = "";
    let bestTok = 0;
    for (const [key, usage] of Object.entries(entry.modelUsage || {})) {
      if (!usage || typeof usage !== "object") continue;
      const mt = (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0) + (Number(usage.cacheReadInputTokens) || 0) + (Number(usage.cacheCreationInputTokens) || 0);
      tot += mt;
      if (key && key !== "<synthetic>" && mt >= bestTok) {
        bestTok = mt;
        bestModel = key;
      }
    }
    if (tot > 0) acc.costStateTokens = tot;
    if (!acc.model && bestModel) acc.model = bestModel;
  }
}

function parseEntryTime(entry, msg) {
  if (msg && typeof msg.timestamp === "number" && msg.timestamp > 0) return msg.timestamp;
  if (typeof entry?.timestamp === "number" && entry.timestamp > 0) return entry.timestamp;
  if (typeof entry?.timestamp === "string" && entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function currentDayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function currentMonthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

function resolveStats(acc, fallbackMtime) {
  const dayStart = currentDayStart();
  const monthStart = currentMonthStart();
  const fallbackTs = fallbackMtime || 0;
  let msgTokSum = 0;
  let msgCostSum = 0;
  let todayWeight = 0;
  let monthWeight = 0;
  let totalWeight = 0;
  if (acc.msgTokens && acc.msgTokens.size > 0) {
    for (const item of acc.msgTokens.values()) {
      msgTokSum += item.tok;
      const est = estimateTurnCost(item.model || acc.model, item.inp, item.out, item.cr, item.cw);
      msgCostSum += est;
      const weight = est > 0 ? est : item.tok;
      const ts = item.ts || fallbackTs;
      totalWeight += weight;
      if (ts >= monthStart) monthWeight += weight;
      if (ts >= dayStart) todayWeight += weight;
    }
  }
  const totalTokens = Math.max(acc.totalTokens || 0, acc.costStateTokens || 0, msgTokSum);
  const rawCost = acc.costStateUSD > 0 ? acc.costStateUSD : (acc.cost > 0 ? acc.cost : msgCostSum);
  let todayCost = 0;
  let monthCost = 0;
  if (acc.turnCosts && acc.turnCosts.length > 0) {
    for (const item of acc.turnCosts) {
      const ts = item.ts || fallbackTs;
      if (ts >= monthStart) monthCost += item.cost;
      if (ts >= dayStart) todayCost += item.cost;
    }
  } else if (rawCost > 0) {
    if (totalWeight > 0) {
      todayCost = rawCost * (todayWeight / totalWeight);
      monthCost = rawCost * (monthWeight / totalWeight);
    } else {
      const ts = acc.costStateTs || fallbackTs;
      if (ts >= monthStart) monthCost = rawCost;
      if (ts >= dayStart) todayCost = rawCost;
    }
  }
  const spec = lookupModelSpec(acc.model);
  return {
    model: acc.model || "",
    contextTokens: acc.contextTokens || 0,
    contextWindow: spec.contextWindow || 0,
    totalTokens,
    cost: rawCost > 0 ? Number(rawCost.toFixed(6)) : 0,
    todayCost: todayCost > 0 ? Number(todayCost.toFixed(6)) : 0,
    monthCost: monthCost > 0 ? Number(monthCost.toFixed(6)) : 0,
  };
}

function estimateTurnCost(model, input, output, cacheRead, cacheWrite) {
  const spec = lookupModelSpec(model);
  if (!spec.cost) return 0;
  return (
    (input || 0) * (spec.cost.input || 0) +
    (output || 0) * (spec.cost.output || 0) +
    (cacheRead || 0) * (spec.cost.cacheRead || 0) +
    (cacheWrite || 0) * (spec.cost.cacheWrite || 0)
  ) / 1_000_000;
}

function lookupModelSpec(model) {
  if (!model || model === "<synthetic>") return { cost: null, contextWindow: 0 };
  const catalog = loadModelCatalog();
  const raw = String(model).trim();
  const bare = raw.split("/").pop().replace(/\[[^\]]*\]$/, "");
  const dotted = bare.replace(/(\d)p(\d)/g, "$1.$2");
  const candidates = [raw, bare, bare.toLowerCase(), `${bare}-priority`, dotted, `${dotted}-priority`];
  for (const key of candidates) {
    const found = catalog.get(key) || catalog.get(key.toLowerCase());
    if (found) return found;
  }
  if (/\[1m\]/i.test(raw)) return { cost: null, contextWindow: 1_000_000 };
  if (/^claude-/i.test(bare)) return { cost: null, contextWindow: 200_000 };
  return { cost: null, contextWindow: 0 };
}

function loadModelCatalog() {
  const ymlPath = path.join(os.homedir(), ".omp", "agent", "models.yml");
  let stat;
  try {
    stat = fs.statSync(ymlPath);
  } catch {
    return modelCatalogCache.map;
  }
  if (modelCatalogCache.mtimeMs === stat.mtimeMs) return modelCatalogCache.map;
  const map = new Map();
  try {
    const text = fs.readFileSync(ymlPath, "utf8");
    let entry = null;
    let inCost = false;
    let inLongContext = false;
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*$/, "");
      const idMatch = /^\s*-\s*id:\s*(\S+)/.exec(line);
      if (idMatch) {
        const id = idMatch[1].trim();
        entry = { id, cost: null, contextWindow: 0 };
        map.set(id, entry);
        map.set(id.toLowerCase(), entry);
        inCost = false;
        inLongContext = false;
        continue;
      }
      if (!entry) continue;
      if (/^\s{8}cost:\s*$/.test(line)) {
        entry.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        inCost = true;
        inLongContext = false;
        continue;
      }
      if (inCost && /^\s{10}longContext:\s*$/.test(line)) {
        inLongContext = true;
        continue;
      }
      if (/^\s{8}[a-zA-Z]/.test(line)) {
        inCost = false;
        inLongContext = false;
      }
      if (inCost && !inLongContext && entry.cost) {
        const rateMatch = /^\s{10}(input|output|cacheRead|cacheWrite):\s*([0-9.]+)/.exec(line);
        if (rateMatch) entry.cost[rateMatch[1]] = Number(rateMatch[2]);
      }
      const cwMatch = /^\s{8}contextWindow:\s*(\d+)/.exec(line);
      if (cwMatch) entry.contextWindow = Number(cwMatch[1]);
    }
  } catch {
    // Keep empty map if models.yml cannot be read.
  }
  modelCatalogCache = { mtimeMs: stat.mtimeMs, map };
  return map;
}

function readHeader(filePath, visit) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const acc = { title: "", preview: "", cwd: "", timestamp: "", mtime: stat.mtimeMs, size: stat.size, sidechain: false };
    for (const entry of parseLines(buf.subarray(0, n).toString("utf8"), true)) visit(entry, acc);
    return acc;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text, dropLastPartial) {
  const lines = text.split("\n");
  if (dropLastPartial) lines.pop();
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // A torn last line is not a record.
    }
  }
  return entries;
}

function ompRoots() {
  const roots = [];
  const home = path.join(os.homedir(), ".omp");
  roots.push(path.join(home, "agent", "sessions"));
  const profiles = path.join(home, "profiles");
  if (isDir(profiles)) {
    for (const name of safeReaddir(profiles)) roots.push(path.join(profiles, name, "agent", "sessions"));
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && isDir(path.join(xdg, "omp"))) {
    roots.push(path.join(xdg, "omp", "sessions"));
  }
  return roots.filter((root) => isDir(root));
}

function cwdForCursorProject(projectDir, folders) {
  const normalized = projectDir.toLowerCase();
  for (const folder of folders) {
    const key = folder.replace(/^\//, "").replaceAll("/", "-").toLowerCase();
    if (normalized === key) return folder;
  }
  return "";
}

function belongsToWorkspace(cwd, folders) {
  if (!cwd || folders.length === 0) return false;
  const sessionPath = path.resolve(cwd);
  return folders.some((folder) => {
    const workspacePath = path.resolve(folder);
    return sessionPath === workspacePath || sessionPath.startsWith(workspacePath + path.sep);
  });
}

function isOmpMirror(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(300);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes("omp-mirror");
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function claudeUserText(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  return contentBlocks(content).map((block) => (block.type === "tool_result" ? "" : block.text || "")).join("\n");
}

function messageText(message) {
  return asText(message?.content);
}

function asText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block === "string" ? block : block?.text || "")).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object" && content.text) return String(content.text);
  return "";
}

function contentBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block && typeof block === "object");
}

function isMetaText(text) {
  const trimmed = text.trimStart();
  return META_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function parseInput(input) {
  if (input && typeof input === "object") return input;
  if (typeof input !== "string" || !input.trim()) return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed : { value: input };
  } catch {
    return { value: input };
  }
}

function filePathOf(name, input) {
  const key = String(name).toLowerCase().replace(/[_-]/g, "");
  const writers = new Set(["write", "edit", "multiedit", "strreplace", "searchreplace", "notebookedit"]);
  if (!writers.has(key)) return "";
  for (const field of ["path", "file_path", "target_file", "notebook_path"]) {
    if (typeof input[field] === "string" && input[field].trim()) return input[field].trim();
  }
  return "";
}

function commandOf(name, input) {
  const key = String(name).toLowerCase();
  const table = {
    bash: ["command", "cmd"],
    shell: ["command", "cmd"],
    read: ["path", "file_path", "target_file"],
    write: ["path", "file_path"],
    edit: ["path", "file_path"],
    multiedit: ["path", "file_path"],
    glob: ["pattern", "glob_pattern", "path"],
    grep: ["pattern", "path"],
    rg: ["pattern"],
    search: ["pattern", "query"],
  };
  for (const field of table[key] || []) {
    if (typeof input[field] === "string" && input[field].trim()) return input[field];
  }
  return "";
}

function inputPreview(input) {
  const keys = Object.keys(input || {});
  if (keys.length === 0) return "";
  try {
    return clip(JSON.stringify(input, null, 2), 1500);
  } catch {
    return "";
  }
}

function visibleUserText(text) {
  const query = String(text).match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  const body = query ? query[1] : String(text).replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "");
  return body.trim();
}

function cleanUserText(text) {
  return visibleUserText(text).replace(/\s+/g, " ").trim();
}

function short(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function uniqueText(text) {
  const trimmed = String(text || "").trim();
  const lines = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 2 && lines[0] === lines[1]) return lines[0];
  const chunks = trimmed.split(/\n\s*\n/).map((chunk) => chunk.trim()).filter(Boolean);
  const unique = [];
  for (const chunk of chunks) {
    if (unique[unique.length - 1] !== chunk) unique.push(chunk);
  }
  return unique.join("\n\n");
}

function clip(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function hasConversationEntries(source, entries) {
  return entries.some((entry) => conversationEntry(source, entry));
}

function conversationEntry(source, entry) {
  if (source === "omp") {
    if (entry.type === "custom" && entry.customType === "tool_execution_start") return true;
    return entry.type === "message" && Boolean(entry.message);
  }
  if (source === "claude") return entry.type === "assistant" || entry.type === "user";
  return false;
}

function hasOmpProcess(commands) {
  return /^\s*(?:\/\S*\/)?omp(?:-[^\s/]+)?(?:\s|$)/m.test(String(commands || ""));
}

module.exports = {
  SOURCES,
  listSessions,
  loadTranscript,
  createTranscriptReader,
  readTranscript,
  snapshotTranscript,
  buildFileDiff,
  ompRoots,
  hasConversationEntries,
  belongsToWorkspace,
  hasOmpProcess,
};

if (require.main === module) {
  const folders = [process.argv[2] || path.join(os.homedir(), "workspace", "caper-repo")];
  const sessions = listSessions(folders);
  const counts = {};
  for (const session of sessions) counts[session.source] = (counts[session.source] || 0) + 1;
  console.log("counts", counts, "workspace", sessions.filter((session) => session.inWorkspace).length);
  for (const source of ["omp", "claude", "cursor"]) {
    const session = sessions.find((item) => item.source === source && item.inWorkspace);
    if (!session) continue;
    const transcript = loadTranscript(session.filePath, source);
    const tools = transcript.turns.flatMap((turn) => turn.tools || []);
    console.log(source, session.title, "turns", transcript.turns.length, "tools", tools.length, tools[0] ? `${tools[0].name} · ${tools[0].sourceLabel}` : "");
  }
}
