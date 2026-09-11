/**
 * Reads what a Claude Code transcript says about its session.
 *
 * A transcript is JSONL under `~/.claude/projects/<cwd-slug>/<session>.jsonl`.
 * The lines that matter are `type: "user"` and `type: "assistant"`, each with
 * `message.content` (a string, or an array of `text` / `tool_use` /
 * `tool_result` blocks), an ISO `timestamp` and the `cwd`. Around them sit
 * bookkeeping lines (`mode`, `file-history-snapshot`, `attachment`,
 * `ai-title`, ...) that are skipped. Assistant turns are often split into
 * one line per content block sharing one `message.id`, so "the last assistant
 * message" is every line with the last text-bearing id.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface TranscriptSummary {
  /** The first real prompt: first line, trimmed, at most 80 characters. */
  title: string | null;
  /** The text blocks of the last assistant message that had any, joined. */
  lastAssistantText: string | null;
  /** Epoch ms of the last timestamped line. */
  lastAt: number | null;
  /** The cwd the session last reported. */
  cwd: string | null;
}

/** Above this the file is not read whole: the head for the title, the tail for the rest. */
export const WHOLE_READ_LIMIT = 20 * 1024 * 1024;
export const HEAD_BYTES = 512 * 1024;
export const TAIL_BYTES = 2 * 1024 * 1024;
export const TITLE_MAX = 80;

interface Block {
  type?: string;
  text?: string;
}

interface Line {
  type?: string;
  isMeta?: boolean;
  timestamp?: string;
  cwd?: string;
  message?: { id?: string; role?: string; content?: string | Block[] };
}

/** Blocks Claude Code wraps around or in place of the person's words. */
const NOISE_BLOCK = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
const NOISE_START = /^<(command-name|command-message|command-args|local-command-|system-reminder|ide_|bash-input|bash-stdout|bash-stderr)/;

/** The text of a message, ignoring tool blocks; null when there is none. */
function textOf(content: string | Block[] | undefined): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  return parts.length ? parts.join("\n") : null;
}

/** A user line's words as a title candidate, or null when it is command/attachment noise. */
function titleOf(line: Line): string | null {
  if (line.isMeta) return null;
  const raw = textOf(line.message?.content);
  if (!raw) return null;
  const cleaned = raw.replace(NOISE_BLOCK, "").trim();
  if (!cleaned || NOISE_START.test(cleaned)) return null;
  const first = cleaned.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first;
}

function parseLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") out.push(o as Line);
    } catch {
      /* a torn or foreign line: skip it */
    }
  }
  return out;
}

function readRange(fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n).toString("utf8");
}

/** Reads the transcript; a missing or unreadable file yields all-null. */
export function readTranscriptSummary(path: string): TranscriptSummary {
  const empty: TranscriptSummary = { title: null, lastAssistantText: null, lastAt: null, cwd: null };
  let fd: number;
  let size: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, "r");
  } catch {
    return empty;
  }
  try {
    if (size <= WHOLE_READ_LIMIT) {
      return summarize(parseLines(readRange(fd, 0, size)), null);
    }
    // The head, cut before its last (torn) line; the tail, cut after its first.
    const headText = readRange(fd, 0, HEAD_BYTES);
    const head = parseLines(headText.slice(0, headText.lastIndexOf("\n") + 1));
    const tailText = readRange(fd, size - TAIL_BYTES, TAIL_BYTES);
    const tail = parseLines(tailText.slice(tailText.indexOf("\n") + 1));
    return summarize(tail, head);
  } catch {
    return empty;
  } finally {
    closeSync(fd);
  }
}

/** `head` is only given on a partial read: the title comes from it when the tail has none. */
export function summarize(lines: Line[], head: Line[] | null): TranscriptSummary {
  let lastAt: number | null = null;
  let cwd: string | null = null;
  // The id of the assistant message whose text is being collected; null when
  // the last assistant line carried no text (closing the previous group).
  let groupId: string | null = null;
  let group: string[] = [];

  const findTitle = (src: Line[]): string | null => {
    for (const l of src) {
      if (l.type !== "user") continue;
      const t = titleOf(l);
      if (t) return t;
    }
    return null;
  };

  for (const l of lines) {
    if (l.type !== "user" && l.type !== "assistant") continue;
    if (typeof l.timestamp === "string") {
      const at = Date.parse(l.timestamp);
      if (!Number.isNaN(at)) lastAt = at;
    }
    if (typeof l.cwd === "string" && l.cwd) cwd = l.cwd;
    if (l.type !== "assistant") continue;
    const text = textOf(l.message?.content);
    const id = typeof l.message?.id === "string" ? l.message.id : null;
    if (text && text.trim()) {
      if (id !== null && id === groupId) group.push(text);
      else {
        groupId = id;
        group = [text];
      }
    } else if (id === null || id !== groupId) {
      // A text-less message that is not part of the current group ends it (the
      // collected text stays); a later message with text starts a fresh one.
      groupId = null;
    }
  }

  const title = head ? (findTitle(head) ?? findTitle(lines)) : findTitle(lines);
  const lastAssistantText = group.length ? group.join("\n").trim() : null;
  return { title, lastAssistantText: lastAssistantText || null, lastAt, cwd };
}
