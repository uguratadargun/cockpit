/**
 * Where the hook shim's socket lives.
 *
 * Pure so the main process (`HookServer.start`) and the tests ask the same
 * question. The value also rides out to every terminal as `COCKPIT_SOCK`, so
 * server and shim always derive it from this one function.
 */
/// <reference types="node" />
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

/**
 * The usable length of a Unix-domain socket path, in bytes.
 *
 * `sockaddr_un.sun_path` is a fixed char array — 104 bytes on macOS/BSD, 108
 * on Linux — and the platforms disagree on what happens with a longer path:
 * Linux rejects the bind with ENAMETOOLONG, macOS TRUNCATES silently. The
 * server then binds, `listen` reports success, no error fires, and the socket
 * appears under a mangled name somewhere up the tree while the intended path
 * never exists. The shim truncates identically, so it even seems to work —
 * until two base dirs share their first ~103 bytes. 100 rather than 104
 * leaves room for the NUL and small differences between what a caller passes
 * and what the kernel is handed.
 */
export const MAX_UNIX_SOCK_PATH = 100;

/** A stable, collision-resistant short name for one base dir. */
function dirHash(dir: string): string {
  return createHash("sha1").update(dir).digest("hex").slice(0, 12);
}

/**
 * The socket path for a cockpit base dir (the app's userData, normally).
 *
 * - Windows: a named pipe; `net`'s IPC there is the flat `\\.\pipe\` namespace.
 * - POSIX, ordinary depth: `<baseDir>/cockpit.sock`, beside the data it serves.
 * - POSIX, too deep for `sun_path`: a hashed name in the temp dir — keyed on
 *   the base dir so it is stable across restarts and distinct per cockpit,
 *   short enough that the kernel takes it whole.
 */
export function cockpitSockPath(baseDir: string, platform: string = process.platform, tmpDir: string = tmpdir()): string {
  if (platform === "win32") return `\\\\.\\pipe\\gate-cockpit-${dirHash(baseDir)}`;
  const beside = `${baseDir.replace(/\/+$/, "")}/cockpit.sock`;
  if (Buffer.byteLength(beside) <= MAX_UNIX_SOCK_PATH) return beside;
  return `${tmpDir.replace(/\/+$/, "")}/cockpit-${dirHash(baseDir)}.sock`;
}
