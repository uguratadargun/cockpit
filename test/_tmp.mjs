/**
 * A temp directory of this test process's own, removed whole on exit.
 *
 * Every test makes `cockpit-*` directories with mkdtemp and not all of them
 * remove theirs; measured here, thousands of them helped fill a disk. So each
 * process points TMPDIR — which os.tmpdir() reads on every call — at a fresh
 * directory and deletes it when it ends. Nothing another process made is
 * touched. Import first, before anything calls tmpdir().
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";

if (isMainThread && !process.env.COCKPIT_TEST_TMP) {
  const own = mkdtempSync(join(os.tmpdir(), "cockpit-tests-"));
  process.env.TMPDIR = own;
  process.env.COCKPIT_TEST_TMP = own;
  process.on("exit", () => {
    try {
      rmSync(own, { recursive: true, force: true });
    } catch {
      // gone already
    }
  });
}
