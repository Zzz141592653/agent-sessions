const crypto = require("crypto");

function hashText(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function emptyRound(hash) {
  return { comments: [], baseHash: hash || "", snapshot: "" };
}

function normalizeRecord(raw) {
  const record = raw && typeof raw === "object" ? raw : {};
  if (!record.current || typeof record.current !== "object") {
    record.current = {
      comments: Array.isArray(record.comments) ? record.comments : [],
      baseHash: "",
      snapshot: "",
    };
  } else {
    if (!Array.isArray(record.current.comments)) record.current.comments = [];
    if (typeof record.current.baseHash !== "string") record.current.baseHash = "";
    if (typeof record.current.snapshot !== "string") record.current.snapshot = "";
  }
  if (!Array.isArray(record.versions)) record.versions = [];
  delete record.comments;
  delete record.snapshot;
  delete record.baseHash;
  return record;
}

function openRound(record, source) {
  const hash = hashText(source);
  const current = record.current;
  if (current.comments.length && current.baseHash && current.baseHash !== hash) {
    record.versions.push({
      id: crypto.randomUUID(),
      closedAt: new Date().toISOString(),
      reason: "changed",
      baseHash: current.baseHash,
      snapshot: current.snapshot || "",
      comments: current.comments,
    });
    record.current = emptyRound(hash);
    return true;
  }
  if (!current.baseHash) current.baseHash = hash;
  return false;
}

function noteLiveFile(record, source) {
  const hash = hashText(source);
  const current = record.current;
  if (current.comments.length || current.baseHash === hash) return false;
  current.baseHash = hash;
  current.snapshot = "";
  return true;
}

function closeRound(record, source) {
  const current = record.current;
  if (!current.comments.length) return false;
  const hash = hashText(source);
  record.versions.push({
    id: crypto.randomUUID(),
    closedAt: new Date().toISOString(),
    reason: "send",
    baseHash: current.baseHash || hash,
    snapshot: current.snapshot || "",
    comments: current.comments,
  });
  record.current = emptyRound(hash);
  return true;
}

module.exports = {
  hashText,
  normalizeRecord,
  openRound,
  noteLiveFile,
  closeRound,
};
