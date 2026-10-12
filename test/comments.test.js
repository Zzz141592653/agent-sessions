const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRecord, openRound, closeRound, noteLiveFile } = require("../comments");

test("an old comment list becomes the current review", () => {
  const record = normalizeRecord({ comments: [{ id: "a", body: "keep" }] });
  assert.equal(record.current.comments.length, 1);
  assert.equal(record.current.comments[0].id, "a");
  assert.deepEqual(record.versions, []);
  assert.equal(record.comments, undefined);
});

test("opening a changed file archives the review and starts empty", () => {
  const record = normalizeRecord(null);
  record.current = {
    comments: [{ id: "a", body: "old" }],
    baseHash: "hash-v1",
    snapshot: "/tmp/v1.txt",
  };
  const archived = openRound(record, "version two");
  assert.equal(archived, true);
  assert.equal(record.versions.length, 1);
  assert.equal(record.versions[0].comments[0].id, "a");
  assert.equal(record.versions[0].snapshot, "/tmp/v1.txt");
  assert.deepEqual(record.current.comments, []);
  assert.notEqual(record.current.baseHash, "hash-v1");
});

test("opening the same text keeps the current comments", () => {
  const record = normalizeRecord(null);
  openRound(record, "same text");
  record.current.comments.push({ id: "a", body: "here" });
  const hash = record.current.baseHash;
  const archived = openRound(record, "same text");
  assert.equal(archived, false);
  assert.equal(record.versions.length, 0);
  assert.equal(record.current.comments.length, 1);
  assert.equal(record.current.baseHash, hash);
});

test("a review with no saved text is not archived on the first open", () => {
  const record = normalizeRecord({ comments: [{ id: "a", body: "existing" }] });
  const archived = openRound(record, "whatever is on disk now");
  assert.equal(archived, false);
  assert.equal(record.versions.length, 0);
  assert.equal(record.current.comments.length, 1);
  assert.ok(record.current.baseHash);
});

test("an empty review follows the file while it is open", () => {
  const record = normalizeRecord(null);
  openRound(record, "first");
  const moved = noteLiveFile(record, "second");
  assert.equal(moved, true);
  assert.equal(record.versions.length, 0);
  assert.notEqual(record.current.baseHash, "");
  const again = noteLiveFile(record, "second");
  assert.equal(again, false);
});

test("sending closes the review and the next one starts empty", () => {
  const record = normalizeRecord(null);
  openRound(record, "draft");
  record.current.comments.push({ id: "a", body: "send me" });
  record.current.snapshot = "/tmp/draft.txt";
  const closed = closeRound(record, "draft");
  assert.equal(closed, true);
  assert.equal(record.versions.length, 1);
  assert.equal(record.versions[0].reason, "send");
  assert.equal(record.versions[0].comments[0].id, "a");
  assert.deepEqual(record.current.comments, []);
  assert.equal(closeRound(record, "draft"), false);
});
