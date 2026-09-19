import "./_ts.mjs";

import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { isModelScopedWindow, publicationOf, shortCommit } = await import("../src/shared/execution.ts");

describe("publicationOf", () => {
  test("a pushed branch is a publication with its ref, commit and time", () => {
    assert.deepEqual(publicationOf({ publishedRef: "gate/dev/abc", publishedCommit: "0123456789abcdef", publishedAt: 1700000000000, publishError: null }), {
      kind: "published",
      ref: "gate/dev/abc",
      commit: "0123456789abcdef",
      at: 1700000000000,
    });
  });

  test("a failed push is the error, and a later success clears it", () => {
    assert.deepEqual(publicationOf({ publishedRef: null, publishedCommit: null, publishedAt: null, publishError: "remote refused" }), { kind: "failed", error: "remote refused" });
    // gate leaves the last successful publication in place and only nulls the error on success.
    assert.equal(publicationOf({ publishedRef: "r", publishedCommit: "c", publishedAt: null, publishError: null })?.kind, "published");
  });

  test("a run with nowhere to publish, or from an older gate, says nothing", () => {
    assert.equal(publicationOf({ publishedRef: null, publishedCommit: null, publishedAt: null, publishError: null }), null);
    assert.equal(publicationOf({}), null);
    // A ref without its commit is half a record; not shown as published.
    assert.equal(publicationOf({ publishedRef: "r", publishedCommit: null }), null);
  });
});

describe("shortCommit", () => {
  test("seven characters, or the whole thing when it is already short", () => {
    assert.equal(shortCommit("0123456789abcdef"), "0123456");
    assert.equal(shortCommit("abc"), "abc");
  });
});

describe("isModelScopedWindow", () => {
  test("a model's weekly window is scoped; the account-wide ones are not", () => {
    assert.equal(isModelScopedWindow("seven_day_fable"), true);
    assert.equal(isModelScopedWindow("seven_day_opus"), true);
    assert.equal(isModelScopedWindow("seven_day"), false);
    assert.equal(isModelScopedWindow("five_hour"), false);
  });
});
