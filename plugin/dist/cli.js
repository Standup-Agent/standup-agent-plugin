"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/cli.ts
var cli_exports = {};
__export(cli_exports, {
  main: () => main
});
module.exports = __toCommonJS(cli_exports);
var import_node_path18 = require("node:path");

// src/capture/worker.ts
var import_node_fs6 = require("node:fs");
var import_node_path7 = require("node:path");

// src/config.ts
var DEFAULTS = {
  /** Raw session capture is kept locally this long, then deleted. */
  rawTtlDays: 30,
  /**
   * Soft cap on text kept from one session for one repo, branch and day (a capture segment).
   * Over it, the conversation is thinned turn by turn (capture/budget.ts), not cut in the middle.
   */
  rawMaxBytesPerSegment: 64 * 1024,
  /** Standup is not shown before this local hour. */
  showNotBeforeHour: 6,
  /** "Not now" postpones the standup for this long. */
  snoozeHours: 2,
  /** Another terminal won't show the standup while one is showing it. */
  showLockMinutes: 10,
  /** Materials handed to the synthesis subagent are cut to this many characters (keeps its context small). */
  synthMaxChars: 1e5,
  /** Repo scan window when joining a team. */
  repoScanDays: 30,
  /** Transcripts re-captured right after join, to show a first standup immediately. */
  joinBackfillDays: 3
};
var CAPTURE = {
  /** One message longer than this is cut; keeps a pasted log from eating the session budget. */
  maxBytesPerMessage: 8 * 1024,
  /** One Claude Code compaction summary is cut to this. */
  maxBytesPerSummary: 6 * 1024,
  /** Unmarked repos a session visited: at most this many sessions remembered per repo for a later capture. */
  maxUnmarkedSessionsPerRepo: 50,
  /** SessionStart recovery only looks at transcripts modified within this window. */
  recoverLookbackDays: 7,
  /** At most this many missed sessions are handed to one recovery worker. */
  recoverMaxSessions: 50,
  /** Commits after the last transcript entry still count to the session (commit right before /exit). */
  commitSlackMinutes: 5,
  /** At most this many sessions are captured right after repos are marked work (task 3). */
  backfillMaxSessions: 200,
  maxCommitsPerBranch: 100,
  maxFilesPerBranch: 200,
  maxCommitMessageBytes: 1024,
  gitTimeoutMs: 5e3,
  /** state.json lock: wait this long, and treat an older lock file as stale. */
  stateLockWaitMs: 2e3,
  stateLockStaleMs: 1e4
};
var NET = {
  timeoutMs: 5e3,
  /** Queued items older than this are dropped (a week of offline is not worth replaying). */
  queueMaxAgeDays: 14,
  /** The server prompt is cached this long. */
  promptCacheHours: 24
};
var DEFAULT_API_BASE = "https://standupagent.co/api";

// src/log.ts
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");

// src/paths.ts
var import_node_os = require("node:os");
var import_node_path = require("node:path");
function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA ?? (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude", "plugins", "data", "standup-agent-dev");
}
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude");
}
var paths = {
  state: () => (0, import_node_path.join)(dataDir(), "state.json"),
  auth: () => (0, import_node_path.join)(dataDir(), "auth.json"),
  digests: () => (0, import_node_path.join)(dataDir(), "digests"),
  queue: () => (0, import_node_path.join)(dataDir(), "queue"),
  promptCache: () => (0, import_node_path.join)(dataDir(), "prompt-cache.json"),
  logDir: () => (0, import_node_path.join)(dataDir(), "log"),
  claudeProjects: () => (0, import_node_path.join)(claudeDir(), "projects")
};

// src/log.ts
function log(level, msg, extra) {
  try {
    (0, import_node_fs.mkdirSync)(paths.logDir(), { recursive: true });
    const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), level, msg, ...extra });
    (0, import_node_fs.appendFileSync)((0, import_node_path2.join)(paths.logDir(), "plugin.log"), line + "\n");
  } catch {
  }
}

// src/secrets.ts
var mark = (kind) => `[REDACTED:${kind}]`;
var B = "(?<![A-Za-z0-9])";
var PLACEHOLDER = new RegExp(
  "^(?:" + [
    "string",
    "str",
    "number",
    "int",
    "integer",
    "bool",
    "boolean",
    "bytes",
    "text",
    "varchar(?:\\(\\d+\\))?",
    "secretstr",
    "optional\\[.*",
    "null",
    "none",
    "nil",
    "undefined",
    "true",
    "false",
    "required",
    "optional",
    "\\*+",
    "x{3,}",
    "\\.{3}",
    "\u2026",
    "<[^>]*>",
    "\\{\\{.*\\}\\}",
    "\\$\\{.*\\}",
    "\\$[A-Za-z_][A-Za-z0-9_]*",
    "%\\(.*",
    "%s",
    "process\\.env\\b.*",
    "os\\.(?:environ|getenv)\\b.*",
    "env\\(.*",
    "getenv\\(.*",
    "config\\..*",
    "settings\\..*",
    "self\\..*",
    "this\\..*",
    "req\\..*",
    "input\\(.*",
    "args\\..*",
    "\\[REDACTED[^\\]]*\\]"
  ].join("|") + ")[,;]?$",
  "i"
);
var SECRET_KEY = "(?:[A-Za-z0-9_.-]*?(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|client[_-]?secret|credentials?)|(?:[A-Za-z0-9_.-]*[_.-])?pass)";
var RULES = [
  // PEM private keys, also an unterminated block (text cut in the middle of a key).
  {
    kind: "private_key",
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g
  },
  { kind: "jwt", re: new RegExp(`${B}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*`, "g") },
  // Anthropic / OpenAI style: sk-ant-api03-…, sk-proj-…, sk-…
  { kind: "api_key", re: new RegExp(`${B}sk-[A-Za-z0-9_-]{20,}`, "g") },
  // Stripe and similar: sk_live_…, rk_test_…
  { kind: "api_key", re: new RegExp(`${B}(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`, "g") },
  { kind: "github_token", re: new RegExp(`${B}(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})`, "g") },
  { kind: "gitlab_token", re: new RegExp(`${B}glpat-[A-Za-z0-9_-]{20,}`, "g") },
  { kind: "slack_token", re: new RegExp(`${B}(?:xox[abposr]|xapp)-[A-Za-z0-9-]{10,}`, "g") },
  { kind: "aws_key", re: new RegExp(`${B}(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA|A3T[A-Z0-9])[A-Z0-9]{16}(?![A-Za-z0-9])`, "g") },
  { kind: "google_key", re: new RegExp(`${B}AIza[0-9A-Za-z_-]{35}`, "g") },
  { kind: "npm_token", re: new RegExp(`${B}npm_[A-Za-z0-9]{36}`, "g") },
  // Authorization headers: Bearer anywhere, Basic/Token only after "Authorization".
  {
    kind: "bearer",
    re: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
    replace: (_m, prefix) => `${prefix}${mark("bearer")}`
  },
  {
    kind: "auth_header",
    re: /\b(Authorization["']?\s*[:=]\s*["']?(?:Basic|Token|Digest)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_m, prefix) => `${prefix}${mark("auth_header")}`
  },
  // Password in a URL: scheme://user:password@host
  {
    kind: "url_password",
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)([^\s@/'"]+)(@)/gi,
    replace: (_m, pre, _pw, at) => `${pre}${mark("url_password")}${at}`
  }
];
var KEY_VALUE = new RegExp(
  `(${B}["']?${SECRET_KEY}["']?\\s*(?::|=|:=)\\s*)(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s"'=][^\\s"',;]*))`,
  "gi"
);
function looksLikeProse(value, whole, end) {
  if (!/^[\p{L}]+$/u.test(value)) return false;
  const nl = whole.indexOf("\n", end);
  const rest = whole.slice(end, nl === -1 ? void 0 : nl).trim();
  return rest !== "" && !rest.startsWith("#");
}
var ENV_LINE = /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*=(.*)$/;
function redactSecrets(input) {
  const found = {};
  const hit = (kind) => {
    found[kind] = (found[kind] ?? 0) + 1;
  };
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.re, (m, ...rest) => {
      hit(rule.kind);
      return rule.replace ? rule.replace(m, ...rest.filter((x) => typeof x === "string")) : mark(rule.kind);
    });
  }
  text = text.replace(KEY_VALUE, (m, prefix, dq, sq2, bare, offset, whole) => {
    const value = dq ?? sq2 ?? bare ?? "";
    if (value === "" || PLACEHOLDER.test(value.trim()) || value.startsWith("[REDACTED")) return m;
    if (bare !== void 0 && /:\s*$/.test(prefix) && looksLikeProse(bare, whole, offset + m.length)) return m;
    hit("password");
    const quote = dq !== void 0 ? '"' : sq2 !== void 0 ? "'" : "";
    return `${prefix}${quote}${mark("password")}${quote}`;
  });
  text = redactEnvBlocks(text, hit);
  return { text, found };
}
function redactEnvBlocks(text, hit) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!ENV_LINE.test(lines[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && (ENV_LINE.test(lines[j]) || /^[ \t]*#/.test(lines[j]))) j++;
    const envLines = lines.slice(i, j).filter((l) => ENV_LINE.test(l)).length;
    if (envLines >= 2) {
      for (let k = i; k < j; k++) {
        const line = lines[k];
        const m = ENV_LINE.exec(line);
        if (!m) continue;
        const value = m[1].trim().replace(/^["']|["']$/g, "");
        if (value === "" || value.startsWith("[REDACTED") || PLACEHOLDER.test(value)) continue;
        lines[k] = line.slice(0, line.length - m[1].length) + mark("env");
        hit("env");
      }
    }
    i = Math.max(j, i + 1);
  }
  return lines.join("\n");
}
function addFound(into, from) {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

// src/standup/schedule.ts
function localDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function periodFrom(state, now) {
  const last = state.last_checkin ? new Date(state.last_checkin) : null;
  return last && !Number.isNaN(last.getTime()) ? last : new Date(now.getTime() - DEFAULTS.joinBackfillDays * 864e5);
}
function gate(state, now) {
  const s = state.standup ?? {};
  if (now.getHours() < DEFAULTS.showNotBeforeHour) return "early";
  if (s.done_date === localDate(now)) return "done_today";
  if (s.showing_until && Date.parse(s.showing_until) > now.getTime()) return "showing";
  if (s.snooze_until && Date.parse(s.snooze_until) > now.getTime()) return "snoozed";
  return "ok";
}

// src/state.ts
var import_node_fs3 = require("node:fs");
var import_node_path4 = require("node:path");

// src/fsutil.ts
var import_node_fs2 = require("node:fs");
var import_node_path3 = require("node:path");
function writeFileAtomic(path, data) {
  (0, import_node_fs2.mkdirSync)((0, import_node_path3.dirname)(path), { recursive: true });
  const tmp = (0, import_node_path3.join)((0, import_node_path3.dirname)(path), `.${(0, import_node_path3.basename)(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    (0, import_node_fs2.writeFileSync)(tmp, data, { mode: 384 });
    (0, import_node_fs2.renameSync)(tmp, path);
  } catch (err) {
    (0, import_node_fs2.rmSync)(tmp, { force: true });
    throw err;
  }
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// src/state.ts
function readState() {
  try {
    const data = JSON.parse((0, import_node_fs3.readFileSync)(paths.state(), "utf8"));
    return typeof data === "object" && data !== null && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
function isWorkRepo(repoPath, state = readState()) {
  return state.repos?.[repoPath] === "work";
}
function workRepos(state = readState()) {
  return Object.entries(state.repos ?? {}).filter(([, kind]) => kind === "work").map(([path]) => path);
}
function updateState(mutate) {
  const lock = `${paths.state()}.lock`;
  (0, import_node_fs3.mkdirSync)((0, import_node_path4.dirname)(lock), { recursive: true });
  const locked = acquire(lock);
  try {
    const state = readState();
    mutate(state);
    writeFileAtomic(paths.state(), JSON.stringify(state, null, 2) + "\n");
    return state;
  } finally {
    if (locked) (0, import_node_fs3.rmSync)(lock, { force: true });
  }
}
function acquire(lock) {
  const deadline = Date.now() + CAPTURE.stateLockWaitMs;
  for (; ; ) {
    try {
      (0, import_node_fs3.closeSync)((0, import_node_fs3.openSync)(lock, "wx"));
      return true;
    } catch {
      try {
        if ((0, import_node_fs3.existsSync)(lock) && Date.now() - (0, import_node_fs3.statSync)(lock).mtimeMs > CAPTURE.stateLockStaleMs) {
          (0, import_node_fs3.rmSync)(lock, { force: true });
          continue;
        }
      } catch {
      }
      if (Date.now() >= deadline) {
        log("error", "state: lock timeout, writing without lock");
        return false;
      }
      sleepSync(25);
    }
  }
}
function recordCapture(sessionId, transcriptMtimeMs, now = /* @__PURE__ */ new Date()) {
  updateState((s) => {
    const captures = { ...s.captures ?? {} };
    captures[sessionId] = transcriptMtimeMs;
    const floor = now.getTime() - CAPTURE.recoverLookbackDays * 864e5;
    for (const [id, mtime] of Object.entries(captures)) if (mtime < floor) delete captures[id];
    s.captures = captures;
    s.last_capture_at = now.toISOString();
  });
}
function noteUnmarked(roots, sessionId, transcriptPath, now = /* @__PURE__ */ new Date()) {
  if (roots.length === 0) return;
  updateState((s) => {
    const seen = { ...s.unmarked_seen ?? {} };
    for (const root of roots) {
      if (s.repos?.[root]) continue;
      const sessions = { ...seen[root]?.sessions ?? {}, [sessionId]: transcriptPath };
      const ids = Object.keys(sessions);
      for (const id of ids.slice(0, Math.max(0, ids.length - CAPTURE.maxUnmarkedSessionsPerRepo))) delete sessions[id];
      seen[root] = { last_seen: now.toISOString(), sessions };
    }
    const floor = now.getTime() - CAPTURE.recoverLookbackDays * 864e5;
    for (const [root, v] of Object.entries(seen)) if (Date.parse(v.last_seen) < floor) delete seen[root];
    s.unmarked_seen = seen;
  });
}
function setRepoKindsWithSessions(kinds) {
  const becameWork = [];
  const sessions = {};
  updateState((s) => {
    const repos = { ...s.repos ?? {} };
    const seen = { ...s.unmarked_seen ?? {} };
    for (const [path, kind] of Object.entries(kinds)) {
      if (kind === "work" && repos[path] !== "work") {
        becameWork.push(path);
        Object.assign(sessions, seen[path]?.sessions ?? {});
      }
      repos[path] = kind;
      delete seen[path];
    }
    s.repos = repos;
    s.unmarked_seen = seen;
  });
  return { becameWork, sessions };
}
function markRepoAsked(path, now = /* @__PURE__ */ new Date()) {
  updateState((s) => {
    s.repos_asked = { ...s.repos_asked ?? {}, [path]: now.toISOString() };
  });
}

// src/store.ts
var import_node_crypto = require("node:crypto");
var import_node_fs4 = require("node:fs");
var import_node_path5 = require("node:path");
function repoKey(repoPath) {
  const hash = (0, import_node_crypto.createHash)("sha256").update(repoPath).digest("hex").slice(0, 8);
  return `${safeName((0, import_node_path5.basename)(repoPath)) || "repo"}-${hash}`;
}
function branchKey(branch) {
  const enc = encodeURIComponent(branch).replace(/\*/g, "%2A");
  return enc === "." || enc === ".." ? enc.replace(/\./g, "%2E") : enc;
}
var safeName = (s) => s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
var safeFile = (s) => s.replace(/[^A-Za-z0-9_-]/g, "_");
function rawPath(repoPath, branch, sessionId, segment) {
  const name = segment ? `${safeFile(sessionId)}_${safeFile(segment)}` : safeFile(sessionId);
  return (0, import_node_path5.join)(paths.digests(), repoKey(repoPath), branchKey(branch), "raw", `${name}.json`);
}
function removeSessionRaw(sessionId) {
  const prefix = safeFile(sessionId);
  let removed = 0;
  for (const repo of listDirs(paths.digests())) {
    for (const branch of listDirs((0, import_node_path5.join)(paths.digests(), repo))) {
      const rawDir = (0, import_node_path5.join)(paths.digests(), repo, branch, "raw");
      let files2;
      try {
        files2 = (0, import_node_fs4.readdirSync)(rawDir);
      } catch {
        continue;
      }
      for (const f of files2) {
        if (f === `${prefix}.json` || f.startsWith(`${prefix}_`) && f.endsWith(".json")) {
          (0, import_node_fs4.rmSync)((0, import_node_path5.join)(rawDir, f), { force: true });
          removed++;
        }
      }
    }
  }
  return removed;
}
function listDirs(dir) {
  try {
    return (0, import_node_fs4.readdirSync)(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
function digestPath(repoId, branch) {
  return (0, import_node_path5.join)(paths.digests(), repoId, branchKey(branch), "digest.md");
}
function readDigest(repoId, branch) {
  try {
    return (0, import_node_fs4.readFileSync)(digestPath(repoId, branch), "utf8");
  } catch {
    return "";
  }
}
var REPO_ID_RE = /^[A-Za-z0-9._-]+-[0-9a-f]{8}$/;
function writeDigest(repoId, branch, text) {
  if (!REPO_ID_RE.test(repoId) || repoId.startsWith(".")) throw new Error(`bad repo id: ${repoId}`);
  writeFileAtomic(digestPath(repoId, branch), text.trim() + "\n");
}
function writeRaw(capture, now = /* @__PURE__ */ new Date()) {
  const file = rawPath(capture.repo.path, capture.branch, capture.session_id, capture.segment);
  writeFileAtomic(file, JSON.stringify(capture, null, 2) + "\n");
  const last = new Date(capture.period.to);
  if (!Number.isNaN(last.getTime())) (0, import_node_fs4.utimesSync)(file, now, last);
  cleanupExpired(now);
  return file;
}
function cleanupExpired(now = /* @__PURE__ */ new Date()) {
  const cutoff = now.getTime() - DEFAULTS.rawTtlDays * 864e5;
  let removed = 0;
  const list2 = (dir) => {
    try {
      return (0, import_node_fs4.readdirSync)(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const repo of list2(paths.digests())) {
    if (!repo.isDirectory()) continue;
    const repoDir = (0, import_node_path5.join)(paths.digests(), repo.name);
    for (const branch of list2(repoDir)) {
      if (!branch.isDirectory()) continue;
      const rawDir = (0, import_node_path5.join)(repoDir, branch.name, "raw");
      for (const f of list2(rawDir)) {
        if (!f.isFile()) continue;
        const file = (0, import_node_path5.join)(rawDir, f.name);
        try {
          const mtime = (0, import_node_fs4.statSync)(file).mtimeMs;
          const expired = f.name.endsWith(".tmp") ? mtime < now.getTime() - 36e5 : mtime < cutoff;
          if ((f.name.endsWith(".json") || f.name.endsWith(".tmp")) && expired) {
            (0, import_node_fs4.rmSync)(file, { force: true });
            removed++;
          }
        } catch {
        }
      }
      removeIfEmpty(rawDir);
      removeIfEmpty((0, import_node_path5.join)(repoDir, branch.name));
    }
    removeIfEmpty(repoDir);
  }
  if (removed > 0) log("info", "store: expired raw captures removed", { removed });
  return removed;
}
function removeIfEmpty(dir) {
  try {
    (0, import_node_fs4.rmdirSync)(dir);
  } catch {
  }
}

// src/capture/budget.ts
function fitTurns(messages, max, m, minCap) {
  const sizes = messages.map((x) => m.size(x.text));
  if (sizes.reduce((n, s) => n + s, 0) <= max) return { kept: messages, indices: messages.map((_, i) => i), dropped: 0, cut: 0 };
  const essential = messages.map((x, i) => x.role === "user" || messages[i + 1]?.role !== "assistant");
  const ess = sizes.filter((_, i) => essential[i]);
  const cost = (cap) => ess.reduce((n, s) => n + Math.min(s, cap), 0);
  const keep = /* @__PURE__ */ new Map();
  let used = 0;
  if (cost(minCap) <= max) {
    let lo = minCap;
    let hi = Math.max(minCap, ...ess);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (cost(mid) <= max) lo = mid;
      else hi = mid - 1;
    }
    messages.forEach((_, i) => {
      if (essential[i]) {
        keep.set(i, lo);
        used += Math.min(sizes[i], lo);
      }
    });
    for (let i = messages.length - 1; i >= 0; i--) {
      if (keep.has(i)) continue;
      const s = Math.min(sizes[i], lo);
      if (used + s > max) continue;
      keep.set(i, lo);
      used += s;
    }
  } else {
    const first = messages.findIndex((x) => x.role === "user");
    if (first >= 0) {
      keep.set(first, minCap);
      used += Math.min(sizes[first], minCap);
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if (keep.has(i) || !essential[i]) continue;
      const s = Math.min(sizes[i], minCap);
      if (used + s > max) break;
      keep.set(i, minCap);
      used += s;
    }
  }
  const kept = [];
  const indices = [];
  let cut = 0;
  messages.forEach((x, i) => {
    const cap = keep.get(i);
    if (cap === void 0) return;
    indices.push(i);
    if (sizes[i] > cap) {
      kept.push({ ...x, text: m.cut(x.text, cap) });
      cut++;
    } else kept.push(x);
  });
  return { kept, indices, dropped: messages.length - kept.length, cut };
}

// src/capture/git.ts
var import_node_child_process = require("node:child_process");
var import_node_path6 = require("node:path");
var TICKET_RE = /[A-Z][A-Z0-9]+-\d+/g;
function git(cwd, args) {
  try {
    return (0, import_node_child_process.execFileSync)("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CAPTURE.gitTimeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      // Don't take index.lock for `status`: the user's own git must never wait on us.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
    });
  } catch {
    return null;
  }
}
function repoRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"])?.trim() || null;
}
function mainWorktreeRoot(root) {
  const common = git(root, ["rev-parse", "--git-common-dir"])?.trim();
  if (!common) return null;
  const abs = (0, import_node_path6.isAbsolute)(common) ? common : (0, import_node_path6.resolve)(root, common);
  const main2 = (0, import_node_path6.dirname)(abs);
  return main2 === root ? null : main2;
}
function gitConfigRemotes(root) {
  const out = git(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]) ?? "";
  const pairs = out.split("\n").map((l) => /^remote\.(.+)\.url (.+)$/.exec(l.trim())).filter((m) => m !== null).map((m) => ({ name: m[1], url: m[2] }));
  pairs.sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin"));
  return pairs.map((p) => p.url);
}
function currentBranch(cwd) {
  return git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])?.trim() || null;
}
function findTickets(...texts) {
  const seen = /* @__PURE__ */ new Set();
  for (const t of texts) for (const m of t.matchAll(TICKET_RE)) seen.add(m[0]);
  return [...seen];
}
var REC = "";
var SEP = "";
var END = "";
function branchActivity(root, branch, from, to) {
  const ref = git(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]) ? `refs/heads/${branch}` : null;
  const commits = [];
  if (ref) {
    const email = git(root, ["config", "user.email"])?.trim();
    const args = [
      "log",
      ref,
      "--no-merges",
      `--since=${from.toISOString()}`,
      `--until=${to.toISOString()}`,
      `--max-count=${CAPTURE.maxCommitsPerBranch}`,
      `--format=${REC}%H${SEP}%aI${SEP}%B${END}`,
      "--name-only"
    ];
    if (email) args.push(`--author=<${email}>`, "--regexp-ignore-case", "--fixed-strings");
    const out = git(root, args) ?? "";
    for (const rec of out.split(REC)) {
      if (!rec.trim()) continue;
      const [head, filesPart = ""] = rec.split(END);
      const [sha, ts, message = ""] = (head ?? "").split(SEP);
      if (!sha || !ts) continue;
      commits.push({
        sha,
        ts,
        message: message.trim(),
        files: filesPart.split("\n").map((f) => f.trim()).filter(Boolean)
      });
    }
  }
  const files2 = /* @__PURE__ */ new Set();
  for (const c of commits) for (const f of c.files) files2.add(f);
  if (currentBranch(root) === branch) for (const f of uncommittedFiles(root)) files2.add(f);
  return {
    branch,
    commits,
    files: [...files2].slice(0, CAPTURE.maxFilesPerBranch),
    tickets: findTickets(branch, ...commits.map((c) => c.message))
  };
}
function uncommittedFiles(root) {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  if (!out) return [];
  const files2 = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    files2.push(p.slice(3));
    if (p[0] === "R" || p[0] === "C") i++;
  }
  return files2;
}

// src/capture/transcript.ts
var import_node_fs5 = require("node:fs");
var import_node_readline = require("node:readline");
var IGNORED_TYPES = /* @__PURE__ */ new Set([
  "system",
  "attachment",
  "summary",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "last-prompt",
  "ai-title",
  "custom-title",
  "atis-latch",
  "bridge-session",
  "cost-state",
  "progress",
  "queue-operation",
  "tag",
  "agent-name",
  "pr-link",
  "file-history-delta"
]);
var USER_NOISE = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<task-notification>",
  "<user-prompt-submit-hook>",
  "[Request interrupted"
];
var INJECTED_BLOCKS = /<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics)>[\s\S]*?<\/\1>/g;
var TRUNCATED = "\u2026[truncated]";
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var str = (v) => typeof v === "string" && v !== "" ? v : void 0;
async function readTranscriptCwd(path) {
  const rl = (0, import_node_readline.createInterface)({ input: (0, import_node_fs5.createReadStream)(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = str(JSON.parse(line).cwd);
        if (cwd) return cwd;
      } catch {
      }
    }
  } finally {
    rl.close();
  }
  return void 0;
}
async function readTranscript(path, opts) {
  const out = { messages: [], compactSummaries: [], rejected: 0, dropped: 0, cut: 0 };
  const unknown = {};
  let badLines = 0;
  let branch;
  let cwd = opts.defaultCwd;
  let tainted = false;
  const hardCap = Math.max(opts.maxBytes ?? 0, opts.maxBytesPerMessage, opts.maxBytesPerSummary ?? 0);
  const rl = (0, import_node_readline.createInterface)({ input: (0, import_node_fs5.createReadStream)(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (!isObj(entry)) {
      badLines++;
      continue;
    }
    const ts = str(entry.timestamp);
    const tms = ts ? Date.parse(ts) : NaN;
    if (ts && !Number.isNaN(tms)) {
      if (out.firstTs === void 0 || tms < Date.parse(out.firstTs)) out.firstTs = ts;
      if (out.lastTs === void 0 || tms > Date.parse(out.lastTs)) out.lastTs = ts;
    }
    out.sessionId ??= str(entry.sessionId);
    out.cwd = str(entry.cwd) ?? out.cwd;
    out.version = str(entry.version) ?? out.version;
    branch = str(entry.gitBranch) ?? branch;
    cwd = str(entry.cwd) ?? cwd;
    if (opts.accept && !opts.accept(cwd)) {
      out.rejected++;
      tainted = true;
      continue;
    }
    const type = str(entry.type) ?? "";
    if (type === "user" && entry.isCompactSummary && !entry.isSidechain) {
      if (opts.maxBytesPerSummary && !tainted) {
        const raw = contentTexts(entry).join("\n");
        let text = cutBytes(raw, hardCap).text.trim();
        if (opts.transform) text = opts.transform(text);
        text = cutBytes(text, opts.maxBytesPerSummary).text;
        if (text) out.compactSummaries.push({ text, ...ts && { ts }, ...branch && { branch }, ...cwd && { cwd } });
      }
      continue;
    }
    let texts;
    if (type === "user") texts = userTexts(entry);
    else if (type === "assistant") texts = assistantTexts(entry);
    else {
      if (!IGNORED_TYPES.has(type)) {
        const key = /^[a-z][a-z0-9_-]{0,39}$/.test(type) ? type : "other";
        unknown[key] = (unknown[key] ?? 0) + 1;
      }
      continue;
    }
    for (const raw of texts) {
      let text = cutBytes(raw, hardCap).text.trim();
      if (opts.transform) text = opts.transform(text);
      const cut = cutBytes(text, opts.maxBytesPerMessage);
      if (cut.cut) out.cut++;
      if (cut.text === "") continue;
      const msg = { role: type, text: cut.text };
      if (ts) msg.ts = ts;
      if (branch) msg.branch = branch;
      if (cwd) msg.cwd = cwd;
      out.messages.push(msg);
    }
  }
  if (opts.maxBytes !== void 0) {
    const fitted = fitTurns(out.messages, opts.maxBytes, BYTES, MIN_CAP_BYTES);
    out.messages = fitted.kept;
    out.dropped += fitted.dropped;
    out.cut += fitted.cut;
  }
  if (badLines > 0 || Object.keys(unknown).length > 0) {
    log("info", "transcript: skipped unrecognized entries", { badLines, unknownTypes: unknown, version: out.version });
  }
  return out;
}
function userTexts(e) {
  if (e.isMeta || e.isSidechain || e.isCompactSummary || e.isVisibleInTranscriptOnly) return [];
  if (e.interruptedMessageId) return [];
  const msg = e.message;
  if (!isObj(msg)) return [];
  const content = msg.content;
  let parts;
  if (typeof content === "string") parts = [content];
  else if (Array.isArray(content)) {
    parts = content.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text);
  } else return [];
  return parts.map(cleanUserText).filter((t) => t !== void 0);
}
function cleanUserText(text) {
  const t = text.trimStart();
  if (t.startsWith("<command-name>") || t.startsWith("<command-message>")) return slashCommand(t);
  if (USER_NOISE.some((p) => t.startsWith(p))) return void 0;
  const cleaned = text.replace(INJECTED_BLOCKS, "").trim();
  return cleaned === "" ? void 0 : cleaned;
}
function slashCommand(t) {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t)?.[1];
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
  if (!name || !args) return void 0;
  return `${name.startsWith("/") ? name : `/${name}`} ${args}`;
}
function assistantTexts(e) {
  if (e.isSidechain || e.isApiErrorMessage || e.isMeta) return [];
  const msg = e.message;
  if (!isObj(msg) || msg.model === "<synthetic>") return [];
  const content = msg.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text);
}
function cutBytes(text, max) {
  if (Buffer.byteLength(text, "utf8") <= max) return { text, cut: false };
  const room = Math.max(0, max - Buffer.byteLength(TRUNCATED, "utf8"));
  const head = Buffer.from(text, "utf8").subarray(0, room).toString("utf8").replace(/�+$/, "");
  return { text: head + TRUNCATED, cut: true };
}
var MIN_CAP_BYTES = 200;
var BYTES = {
  size: (t) => Buffer.byteLength(t, "utf8"),
  cut: (t, max) => cutBytes(t, max).text
};
function contentTexts(e) {
  const msg = e.message;
  if (!isObj(msg)) return [];
  if (typeof msg.content === "string") return [msg.content];
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text);
}

// src/capture/worker.ts
async function runCapture(jobs) {
  for (const job of Array.isArray(jobs) ? jobs : [jobs]) {
    try {
      await captureSession(job);
    } catch (err) {
      log("error", "capture failed", { session: short(job.session_id), error: err instanceof Error ? err.message : String(err) });
    }
  }
}
var short = (id) => typeof id === "string" ? id.slice(0, 8) : void 0;
async function captureSession(job, now = /* @__PURE__ */ new Date()) {
  const session = short(job.session_id);
  if (typeof job.session_id !== "string" || !job.transcript_path) {
    log("info", "capture: skipped, no transcript", { session, reason: job.reason });
    return;
  }
  let mtimeMs;
  try {
    mtimeMs = (0, import_node_fs6.statSync)(job.transcript_path).mtimeMs;
  } catch {
    log("info", "capture: skipped, transcript missing", { session, reason: job.reason });
    return;
  }
  const done = (skip) => {
    recordCapture(job.session_id, mtimeMs, now);
    log("info", `capture: skipped, ${skip}`, { session, reason: job.reason });
  };
  const state = readState();
  const roots = /* @__PURE__ */ new Map();
  const rootOf = (cwd) => {
    if (!roots.has(cwd)) roots.set(cwd, repoRoot(cwd));
    return roots.get(cwd);
  };
  const works = /* @__PURE__ */ new Map();
  const unmarked = /* @__PURE__ */ new Set();
  let sawRepo = false;
  const workOf = (cwd) => {
    const root = cwd ? rootOf(cwd) : null;
    if (!root) return null;
    sawRepo = true;
    if (!works.has(root)) {
      const repo = markedWorkRepo(root, state);
      works.set(root, repo);
      if (!repo && !isMarked(root, state)) unmarked.add(root);
    }
    return works.get(root);
  };
  const redacted = {};
  const transcript = await readTranscript(job.transcript_path, {
    maxBytesPerMessage: CAPTURE.maxBytesPerMessage,
    maxBytesPerSummary: CAPTURE.maxBytesPerSummary,
    defaultCwd: job.cwd,
    accept: (cwd) => workOf(cwd) !== null,
    transform: (text) => {
      const r = redactSecrets(text);
      addFound(redacted, r.found);
      return r.text;
    }
  });
  noteUnmarked([...unmarked], job.session_id, job.transcript_path, now);
  removeSessionRaw(job.session_id);
  const fallbackTs = new Date(mtimeMs).toISOString();
  const segments = groupSegments(transcript.messages, workOf, (repo) => currentBranch(repo) ?? "HEAD", fallbackTs);
  if (segments.size === 0) {
    const repo = workOf(transcript.cwd ?? job.cwd);
    if (!repo) return done(sawRepo ? "repo is not marked as work" : "not a git repo");
    const day = localDate(new Date(transcript.lastTs ?? fallbackTs));
    segments.set(`${repo}\0${currentBranch(repo) ?? "HEAD"}\0${day}`, { repo, branch: currentBranch(repo) ?? "HEAD", day, messages: [] });
  }
  let written = 0;
  let commits = 0;
  let dropped = 0;
  let cut = transcript.cut;
  for (const seg of segments.values()) {
    const times = seg.messages.map((m) => m.ts).filter((t) => !!t).sort((a, b) => Date.parse(a) - Date.parse(b));
    const from = times[0] ?? transcript.firstTs ?? fallbackTs;
    const to = times[times.length - 1] ?? transcript.lastTs ?? fallbackTs;
    const until = new Date(new Date(to).getTime() + CAPTURE.commitSlackMinutes * 6e4);
    const activity = branchActivity(seg.repo, seg.branch, new Date(from), until);
    if (seg.messages.length === 0 && activity.commits.length === 0) continue;
    const fitted = fitTurns(seg.messages, DEFAULTS.rawMaxBytesPerSegment, BYTES, MIN_CAP_BYTES);
    dropped += fitted.dropped;
    cut += fitted.cut;
    const summaries = transcript.compactSummaries.filter(
      (c) => (c.cwd ? workOf(c.cwd) : null) === seg.repo && (c.branch && c.branch !== "HEAD" ? c.branch : seg.branch) === seg.branch && c.ts && localDate(new Date(c.ts)) === seg.day
    );
    const capture = {
      schema: 1,
      session_id: job.session_id,
      repo: { path: seg.repo, name: (0, import_node_path7.basename)(seg.repo) },
      branch: seg.branch,
      segment: seg.day,
      captured_at: now.toISOString(),
      period: { from, to },
      cc_version: transcript.version,
      reason: job.reason,
      messages: fitted.kept.map((m) => ({ role: m.role, ts: m.ts, text: m.text })),
      truncated: { dropped: fitted.dropped, cut: fitted.cut },
      commits: activity.commits.map((c) => {
        const r = redactSecrets(c.message);
        addFound(redacted, r.found);
        return { sha: c.sha, ts: c.ts, message: cutBytes(r.text, CAPTURE.maxCommitMessageBytes).text };
      }),
      files: activity.files,
      tickets: activity.tickets,
      redacted: {}
    };
    if (summaries.length) capture.compact_summaries = summaries.map((c) => ({ ts: c.ts, text: c.text }));
    capture.redacted = { ...redacted };
    writeRaw(capture, now);
    written++;
    commits += capture.commits.length;
  }
  recordCapture(job.session_id, mtimeMs, now);
  log("info", "capture: done", {
    session,
    reason: job.reason,
    repos: [...new Set([...segments.values()].map((g) => (0, import_node_path7.basename)(g.repo)))],
    segments: written,
    messages: transcript.messages.length,
    commits,
    dropped,
    cut,
    summaries: transcript.compactSummaries.length,
    skipped_entries: transcript.rejected,
    unmarked_repos: unmarked.size,
    redacted
  });
}
function markedWorkRepo(root, state) {
  if (isWorkRepo(root, state)) return root;
  const main2 = mainWorktreeRoot(root);
  return main2 && isWorkRepo(main2, state) ? main2 : null;
}
function isMarked(root, state) {
  if (state.repos?.[root]) return true;
  const main2 = mainWorktreeRoot(root);
  return !!main2 && !!state.repos?.[main2];
}
function groupSegments(messages, workOf, branchOf, fallbackTs) {
  const groups = /* @__PURE__ */ new Map();
  let lastTs = fallbackTs;
  for (const m of messages) {
    const repo = workOf(m.cwd);
    if (!repo) continue;
    lastTs = m.ts ?? lastTs;
    const branch = m.branch && m.branch !== "HEAD" ? m.branch : branchOf(repo);
    const day = localDate(new Date(lastTs));
    const key = `${repo}\0${branch}\0${day}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { repo, branch, day, messages: [] });
    g.messages.push(m);
  }
  return groups;
}

// src/api.ts
var import_node_crypto2 = require("node:crypto");
var import_node_fs7 = require("node:fs");
var import_node_path8 = require("node:path");
function readAuth() {
  try {
    return JSON.parse((0, import_node_fs7.readFileSync)(paths.auth(), "utf8"));
  } catch {
    return {};
  }
}
function memberToken() {
  const t = readAuth().member_token;
  return typeof t === "string" && t !== "" ? t : null;
}
function apiBaseUrl() {
  return process.env.STANDUP_AGENT_API_URL ?? readAuth().api_base ?? DEFAULT_API_BASE;
}
function enqueueReport(report) {
  return enqueue({ kind: "report", body: report });
}
function enqueueEvent(type, now = /* @__PURE__ */ new Date()) {
  return enqueue({ kind: "event", body: { type, ts: now.toISOString() } });
}
var seq = 0;
function enqueue(item) {
  const file = (0, import_node_path8.join)(paths.queue(), `${Date.now().toString().padStart(15, "0")}-${String(seq++).padStart(6, "0")}-${item.kind}-${(0, import_node_crypto2.randomUUID)()}.json`);
  writeFileAtomic(file, JSON.stringify(item));
  return file;
}
async function flush(now = Date.now()) {
  const files2 = queued();
  const res = { sent: 0, left: files2.length };
  if (files2.length === 0) return res;
  const token = memberToken();
  if (!token) return { ...res, stopped: "no_token" };
  for (const file of files2) {
    let item;
    try {
      if (now - (0, import_node_fs7.statSync)(file).mtimeMs > NET.queueMaxAgeDays * 864e5) {
        (0, import_node_fs7.rmSync)(file, { force: true });
        res.left--;
        log("info", "queue: dropped stale item");
        continue;
      }
      item = JSON.parse((0, import_node_fs7.readFileSync)(file, "utf8"));
    } catch {
      (0, import_node_fs7.rmSync)(file, { force: true });
      res.left--;
      continue;
    }
    const status = await post(item.kind === "report" ? "/reports" : "/events", item.body, token);
    if (status === null) return { ...res, stopped: "network" };
    if (status === 401) return { ...res, stopped: "auth" };
    if (status >= 500) return { ...res, stopped: "network" };
    if (status >= 400) log("error", "queue: item rejected", { kind: item.kind, status });
    (0, import_node_fs7.rmSync)(file, { force: true });
    res.left--;
    if (status < 400) res.sent++;
  }
  return res;
}
function queued() {
  try {
    return (0, import_node_fs7.readdirSync)(paths.queue()).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort().map((f) => (0, import_node_path8.join)(paths.queue(), f));
  } catch {
    return [];
  }
}
async function post(path, body, token) {
  try {
    const r = await fetch(apiBaseUrl() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NET.timeoutMs)
    });
    return r.status;
  } catch {
    return null;
  }
}
async function getJSON(path) {
  const token = memberToken();
  if (!token) return null;
  try {
    const r = await fetch(apiBaseUrl() + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(NET.timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// src/commands/repos.ts
var import_node_path11 = require("node:path");

// src/capture/discover.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs8 = require("node:fs");
var import_node_path9 = require("node:path");
function projectDirName(path) {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}
function findSessions(o) {
  const dirs2 = o.repos.map(projectDirName);
  if (dirs2.length === 0) return [];
  const found = [];
  for (const dir of safeReaddir(o.projectsDir)) {
    if (!dirs2.some((r) => dir === r || dir.startsWith(`${r}-`))) continue;
    for (const file of safeReaddir((0, import_node_path9.join)(o.projectsDir, dir))) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = (0, import_node_path9.basename)(file, ".jsonl");
      if (sessionId === o.exclude) continue;
      const path = (0, import_node_path9.join)(o.projectsDir, dir, file);
      let mtime;
      try {
        mtime = (0, import_node_fs8.statSync)(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < o.sinceMs) continue;
      const last = o.captures?.[sessionId];
      if (last !== void 0 && mtime <= last) continue;
      found.push({ job: { session_id: sessionId, transcript_path: path, reason: o.reason }, mtime });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, o.max).map((f) => f.job);
}
function spawnCapture(cliPath, jobs) {
  if (jobs.length === 0) return;
  (0, import_node_child_process2.spawn)(process.execPath, [cliPath, "capture", JSON.stringify(jobs)], { detached: true, stdio: "ignore" }).unref();
}
function safeReaddir(dir) {
  try {
    return (0, import_node_fs8.readdirSync)(dir);
  } catch {
    return [];
  }
}

// src/repos.ts
var import_node_fs9 = require("node:fs");
var import_node_path10 = require("node:path");
function normalizeRemote(url) {
  let u = url.trim();
  if (u === "") return null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    if (!scp) return null;
    u = `ssh://${scp[1]}/${scp[2]}`;
  }
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (parsed.protocol === "file:" || !parsed.hostname) return null;
  const path = parsed.pathname.replace(/\.git\/?$/i, "").replace(/^\/+|\/+$/g, "");
  if (path === "") return null;
  return `${parsed.hostname}/${path}`.toLowerCase();
}
function normalizeOrg(org) {
  const o = org.trim();
  return normalizeRemote(o) ?? o.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}
function matchesWorkOrg(remotes, workOrgs) {
  const orgs = workOrgs.map(normalizeOrg).filter((o) => o.includes("/"));
  return remotes.some((r) => orgs.some((o) => r === o || r.startsWith(`${o}/`)));
}
function repoOf(cwd) {
  if (!(0, import_node_fs9.existsSync)(cwd)) return null;
  const root = repoRoot(cwd);
  if (!root) return null;
  const path = mainWorktreeRoot(root) ?? root;
  const remotes = [...new Set(gitConfigRemotes(path).map(normalizeRemote).filter((r) => r !== null))];
  return { path, name: (0, import_node_path10.basename)(path), remotes };
}
async function scanRepos(projectsDir, days, now = Date.now()) {
  const floor = now - days * 864e5;
  const byPath = /* @__PURE__ */ new Map();
  for (const dir of safeReaddir2(projectsDir)) {
    const newest = newestTranscript((0, import_node_path10.join)(projectsDir, dir), floor);
    if (!newest) continue;
    const cwd = await readTranscriptCwd(newest.path);
    if (!cwd) continue;
    const repo = repoOf(cwd);
    if (!repo) continue;
    const lastActivity = new Date(newest.mtime).toISOString();
    const seen = byPath.get(repo.path);
    if (!seen || seen.lastActivity < lastActivity) byPath.set(repo.path, { ...repo, lastActivity });
  }
  return [...byPath.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}
function classify(candidates, state) {
  const out = { marked: [], autoWork: [], ask: [] };
  const orgs = state.team?.work_orgs ?? [];
  for (const c of candidates) {
    const kind = state.repos?.[c.path];
    if (kind) out.marked.push({ ...c, kind });
    else if (matchesWorkOrg(c.remotes, orgs)) out.autoWork.push(c);
    else out.ask.push(c);
  }
  return out;
}
function newestTranscript(dir, floor) {
  let best = null;
  for (const f of safeReaddir2(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const path = (0, import_node_path10.join)(dir, f);
    try {
      const mtime = (0, import_node_fs9.statSync)(path).mtimeMs;
      if (mtime >= floor && (!best || mtime > best.mtime)) best = { path, mtime };
    } catch {
    }
  }
  return best;
}
function safeReaddir2(dir) {
  try {
    return (0, import_node_fs9.readdirSync)(dir);
  } catch {
    return [];
  }
}

// src/commands/repos.ts
async function reposCommand(args, cliPath, now = Date.now()) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "scan":
      return { code: 0, out: await scan(cliPath, now) };
    case "set":
      return set(rest, cliPath, now);
    case "list":
    case void 0:
      return { code: 0, out: list() };
    default:
      return { code: 1, out: { error: `unknown subcommand: ${sub}`, usage: "repos scan | set <path>=work|personal ... | list" } };
  }
}
var brief = (r) => ({ path: r.path, name: r.name, remote: r.remotes[0] ?? null, last_activity: r.lastActivity.slice(0, 10) });
async function scan(cliPath, now) {
  const state = readState();
  const found = classify(await scanRepos(paths.claudeProjects(), DEFAULTS.repoScanDays, now), state);
  if (found.autoWork.length > 0) {
    const { becameWork, sessions } = setRepoKindsWithSessions(Object.fromEntries(found.autoWork.map((r) => [r.path, "work"])));
    backfill(becameWork, cliPath, now, sessions);
  }
  log("info", "repos: scan", { found: found.marked.length + found.autoWork.length + found.ask.length, auto: found.autoWork.length, ask: found.ask.length });
  return {
    team: state.team?.name ?? null,
    work_orgs: state.team?.work_orgs ?? [],
    auto_marked_work: found.autoWork.map(brief),
    ask: found.ask.map(brief),
    already_marked: found.marked.map((r) => ({ ...brief(r), kind: r.kind }))
  };
}
function set(pairs, cliPath, now) {
  const kinds = {};
  for (const p of pairs) {
    const eq = p.lastIndexOf("=");
    const path = p.slice(0, eq);
    const kind = p.slice(eq + 1);
    if (eq <= 0 || !(0, import_node_path11.isAbsolute)(path) || kind !== "work" && kind !== "personal") {
      return { code: 1, out: { error: `expected <absolute path>=work|personal, got: ${p}` } };
    }
    kinds[repoOf(path)?.path ?? path] = kind;
  }
  if (Object.keys(kinds).length === 0) return { code: 1, out: { error: "nothing to set" } };
  const { becameWork, sessions } = setRepoKindsWithSessions(kinds);
  const backfilled = backfill(becameWork, cliPath, now, sessions);
  log("info", "repos: set", { work: Object.values(kinds).filter((k) => k === "work").length, personal: Object.values(kinds).filter((k) => k === "personal").length, backfilled });
  return { code: 0, out: { updated: kinds, backfill_sessions: backfilled } };
}
function list() {
  const state = readState();
  return {
    team: state.team?.name ?? null,
    repos: Object.entries(state.repos ?? {}).map(([path, kind]) => ({ path, kind }))
  };
}
function backfill(repos, cliPath, now, visited = {}) {
  if (repos.length === 0) return 0;
  const found = findSessions({
    projectsDir: paths.claudeProjects(),
    repos,
    sinceMs: now - DEFAULTS.joinBackfillDays * 864e5,
    reason: "backfill",
    max: CAPTURE.backfillMaxSessions
  });
  const ids = new Set(found.map((j) => j.session_id));
  const extra = Object.entries(visited).filter(([id]) => !ids.has(id)).map(([id, path]) => ({ session_id: id, transcript_path: path, reason: "backfill" }));
  const jobs = [...found, ...extra];
  spawnCapture(cliPath, jobs);
  return jobs.length;
}

// src/commands/team.ts
var import_node_fs11 = require("node:fs");
var import_node_path13 = require("node:path");

// src/identity.ts
var import_node_child_process3 = require("node:child_process");
var import_node_fs10 = require("node:fs");
var import_node_os2 = require("node:os");
var import_node_path12 = require("node:path");
function suggestIdentity() {
  const file = process.env.CLAUDE_CONFIG_DIR ? (0, import_node_path12.join)(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : (0, import_node_path12.join)((0, import_node_os2.homedir)(), ".claude.json");
  try {
    const acc = JSON.parse((0, import_node_fs10.readFileSync)(file, "utf8")).oauthAccount;
    const name2 = typeof acc?.displayName === "string" ? acc.displayName : null;
    const email2 = typeof acc?.emailAddress === "string" ? acc.emailAddress : null;
    if (name2 || email2) return { name: name2, email: email2, source: "claude" };
  } catch {
  }
  const git3 = (key) => {
    try {
      return (0, import_node_child_process3.execFileSync)("git", ["config", "--global", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3e3 }).trim() || null;
    } catch {
      return null;
    }
  };
  const name = git3("user.name");
  const email = git3("user.email");
  return { name, email, source: name || email ? "git" : "none" };
}

// src/commands/team.ts
function parseInvite(link) {
  const s = link.trim().replace(/[.,;!?»")\]]+$/, "");
  const m = /^(?:(https?):\/\/)?([a-z0-9.-]+(?::\d+)?)\/join\/([A-Za-z0-9]{10,})$/i.exec(s);
  if (m) {
    const scheme = m[1] ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(m[2]) ? "http" : "https");
    return { code: m[3].toUpperCase(), apiBase: `${scheme}://${m[2]}/api` };
  }
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return { code: s.toUpperCase(), apiBase: process.env.STANDUP_AGENT_API_URL ?? DEFAULT_API_BASE };
  return null;
}
async function request(url, init = {}) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(NET.timeoutMs) });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  } catch {
    return null;
  }
}
async function joinInfo(link) {
  const inv = parseInvite(link);
  if (!inv) return { code: 1, out: { error: "This doesn\u2019t look like a Standup Agent invite link (\u2026/join/<CODE>)." } };
  const r = await request(`${inv.apiBase}/invites/${inv.code}`);
  if (!r) return { code: 1, out: { error: `Can\u2019t reach ${inv.apiBase}. Check your connection and try again.` } };
  if (r.status === 404) return { code: 1, out: { error: "This invite link is invalid or was revoked \u2014 ask your manager for a new one." } };
  if (r.status !== 200) return { code: 1, out: { error: `The server responded with ${r.status}.` } };
  const current = readState().team?.name ?? null;
  return {
    code: 0,
    out: {
      team_name: r.body.team_name,
      suggested: suggestIdentity(),
      // MVP: one team per developer; joining another one leaves the current.
      current_team: current,
      leaves_current_team: current !== null && current !== r.body.team_name
    }
  };
}
async function joinTeam(link, name, email, now = /* @__PURE__ */ new Date()) {
  const inv = parseInvite(link);
  if (!inv) return { code: 1, out: { error: "This doesn\u2019t look like a Standup Agent invite link." } };
  if (!name.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) return { code: 1, out: { error: "A name and an email are required." } };
  const r = await request(`${inv.apiBase}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: inv.code, display_name: name.trim(), email: email.trim() })
  });
  if (!r) return { code: 1, out: { error: "Can\u2019t reach the server. Try again." } };
  if (r.status === 404) return { code: 1, out: { error: "This invite link is invalid or was revoked \u2014 ask your manager for a new one." } };
  if (r.status === 429) return { code: 1, out: { error: "Too many attempts \u2014 wait a minute." } };
  if (r.status !== 200 || typeof r.body.member_token !== "string") return { code: 1, out: { error: `The server responded with ${r.status}.` } };
  const auth = { member_token: r.body.member_token, member_id: String(r.body.member_id), api_base: inv.apiBase };
  writeFileAtomic(paths.auth(), JSON.stringify(auth));
  const workOrgs = Array.isArray(r.body.work_orgs) ? r.body.work_orgs.filter((o) => typeof o === "string") : [];
  updateState((s) => {
    if (s.team?.name && s.team.name !== r.body.team_name) {
      s.repos_asked = {};
      s.standup = {};
    }
    s.team = { name: String(r.body.team_name), work_orgs: workOrgs, joined_at: now.toISOString() };
  });
  log("info", "team: joined");
  return { code: 0, out: { team_name: r.body.team_name, work_orgs: workOrgs, next: "Next: initial repo marking \u2014 repos scan." } };
}
async function leave() {
  const token = memberToken();
  if (token) {
    const r = await request(`${apiBaseUrl()}/me`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!r || r.status !== 204 && r.status !== 401) {
      return { code: 1, out: { error: "Can\u2019t reach the server \u2014 nothing was deleted there. Try again later; nothing local was touched." } };
    }
  }
  for (const p of [paths.auth(), paths.digests(), paths.queue(), paths.promptCache(), (0, import_node_path13.join)(dataDir(), "standup-materials.json"), paths.state()]) {
    (0, import_node_fs11.rmSync)(p, { recursive: true, force: true });
  }
  log("info", "team: left");
  return { code: 0, out: { left: true, note: "You left the team. Your standups were deleted on the server, and your local materials and repo marking on this computer." } };
}

// src/standup/commands.ts
var import_node_crypto3 = require("node:crypto");
var import_node_fs14 = require("node:fs");
var import_node_path16 = require("node:path");

// src/prompt.ts
var import_node_fs12 = require("node:fs");
var import_node_path14 = require("node:path");
async function standupPrompt(pluginRoot, now = Date.now()) {
  const cached = readCache();
  if (cached && now - cached.fetched_at < NET.promptCacheHours * 36e5) return cached;
  const fresh = await getJSON("/prompts/standup");
  if (fresh && typeof fresh.version === "string" && typeof fresh.text === "string") {
    writeFileAtomic(paths.promptCache(), JSON.stringify({ ...fresh, fetched_at: now }));
    return fresh;
  }
  return cached ?? fallback(pluginRoot);
}
function fallback(pluginRoot) {
  const raw = (0, import_node_fs12.readFileSync)((0, import_node_path14.join)(pluginRoot, "prompts", "standup.fallback.md"), "utf8");
  const m = /^<!--\s*version:\s*(\S+)\s*-->\s*\n/.exec(raw);
  return { version: m?.[1] ?? "fallback", text: m ? raw.slice(m[0].length) : raw };
}
function readCache() {
  try {
    const c = JSON.parse((0, import_node_fs12.readFileSync)(paths.promptCache(), "utf8"));
    return typeof c.text === "string" && typeof c.version === "string" && typeof c.fetched_at === "number" ? c : null;
  } catch {
    return null;
  }
}

// src/standup/materials.ts
var import_node_child_process4 = require("node:child_process");
var import_node_fs13 = require("node:fs");
var import_node_path15 = require("node:path");
var PART_BYTES = 24e3;
function rawFilesSince(fromMs) {
  const out = [];
  for (const repo of dirs(paths.digests())) {
    for (const branch of dirs((0, import_node_path15.join)(paths.digests(), repo))) {
      const raw = (0, import_node_path15.join)(paths.digests(), repo, branch, "raw");
      for (const f of files(raw)) {
        if (!f.endsWith(".json")) continue;
        try {
          if ((0, import_node_fs13.statSync)((0, import_node_path15.join)(raw, f)).mtimeMs > fromMs) out.push((0, import_node_path15.join)(raw, f));
        } catch {
        }
      }
    }
  }
  return out;
}
function loadCaptures(fromMs) {
  const caps = [];
  for (const f of rawFilesSince(fromMs)) {
    try {
      caps.push(JSON.parse((0, import_node_fs13.readFileSync)(f, "utf8")));
    } catch {
    }
  }
  return caps.sort((a, b) => a.period.from.localeCompare(b.period.from));
}
function outsideCommits(repos, from, known, limitPerRepo = CAPTURE.maxCommitsPerBranch) {
  const out = [];
  for (const repo of repos) {
    const email = git2(repo, ["config", "user.email"])?.trim();
    if (!email) continue;
    const log2 = git2(repo, [
      "log",
      "--branches",
      "--no-merges",
      "--source",
      `--since=${from.toISOString()}`,
      `--author=<${email}>`,
      "--regexp-ignore-case",
      "--fixed-strings",
      `--max-count=${limitPerRepo + known.size}`,
      "--format=%H%x1f%S%x1f%aI%x1f%s%x1e"
    ]);
    let n = 0;
    for (const rec of (log2 ?? "").split("")) {
      const [sha, ref, ts, subject] = rec.trim().split("");
      if (!sha || !ts || known.has(sha)) continue;
      out.push({ repo: (0, import_node_path15.basename)(repo), repoPath: repo, branch: (ref ?? "").replace(/^refs\/heads\//, ""), sha, ts, message: subject ?? "" });
      if (++n >= limitPerRepo) break;
    }
  }
  return out;
}
function collect(from, to, workRepos2) {
  const captures = loadCaptures(from.getTime());
  const known = new Set(captures.flatMap((c) => c.commits.map((k) => k.sha)));
  return { from: from.toISOString(), to: to.toISOString(), captures, outside: outsideCommits(workRepos2, from, known) };
}
function devLanguage(captures) {
  let cyr = 0;
  let lat = 0;
  for (const c of captures)
    for (const m of c.messages)
      if (m.role === "user") {
        cyr += (m.text.match(/[А-Яа-яЁё]/g) ?? []).length;
        lat += (m.text.match(/[A-Za-z]/g) ?? []).length;
      }
  return cyr > lat * 0.5 ? "Russian" : "English";
}
function render(m, prompt, maxChars = DEFAULTS.synthMaxChars) {
  const head = [`# Prompt (prompt_version: ${prompt.version})`, prompt.text.trim(), "", "# Input", `period: {from: ${m.from}, to: ${m.to}}`, `dev_language: ${devLanguage(m.captures)}`, ""];
  const body = [];
  const sizeOf = (c) => c.messages.reduce((n, x) => n + x.text.length, 0) + (c.compact_summaries ?? []).reduce((n, x) => n + x.text.length, 0);
  const total = m.captures.reduce((n, c) => n + sizeOf(c), 0);
  const budgetOf = (c) => total <= maxChars ? Infinity : Math.max(2e3, Math.floor(maxChars * sizeOf(c) / total));
  const branches = /* @__PURE__ */ new Map();
  const get = (repo, repoPath, branch) => {
    const repoId = repoKey(repoPath);
    const k = `${repoId}\0${branch}`;
    let b = branches.get(k);
    if (!b) branches.set(k, b = { repo, repoId, branch, caps: [], outside: [] });
    return b;
  };
  for (const c of m.captures) get(c.repo.name, c.repo.path, c.branch).caps.push(c);
  for (const k of m.outside) get(k.repo, k.repoPath, k.branch || "HEAD").outside.push(k);
  for (const b of branches.values()) {
    const tickets = [...new Set(b.caps.flatMap((c) => c.tickets))];
    body.push(`## repo: ${b.repo} \xB7 repo_id: ${b.repoId} \xB7 branch: ${b.branch}${tickets.length ? ` \xB7 ticket: ${tickets.join(", ")}` : ""}`);
    const digest = readDigest(b.repoId, b.branch).trim();
    body.push("existing_digest:", digest || "(empty)", "", "raw entries:");
    const commits = [...new Map(b.caps.flatMap((c) => c.commits).map((k) => [k.sha, k])).values()].sort((x, y) => x.ts.localeCompare(y.ts));
    if (commits.length) {
      body.push("commits:");
      for (const k of commits) body.push(`- ${k.ts.slice(0, 16)} ${k.sha.slice(0, 7)} ${k.message.split("\n")[0]}`);
    }
    const files2 = [...new Set(b.caps.flatMap((c) => c.files))];
    if (files2.length) body.push(`changed files: ${files2.slice(0, 30).join(", ")}${files2.length > 30 ? ` (+${files2.length - 30})` : ""}`);
    for (const c of b.caps) {
      body.push(`session ${c.period.from.slice(0, 16)} \u2014 ${c.period.to.slice(11, 16)}:`);
      body.push(...sessionLines(c, budgetOf(c)));
    }
    if (b.outside.length) {
      body.push("commits_outside_sessions:");
      for (const k of b.outside) body.push(`- ${k.ts.slice(0, 16)} ${k.sha.slice(0, 7)} ${k.message}`);
    }
    body.push("");
  }
  if (body.length === 0) body.push("No work found since the last standup.");
  return split([...head, ...body]);
}
var OMITTED = "\u2026 (part of the conversation omitted)";
var CUT = "\u2026[cut]";
var CHARS = { size: (t) => t.length, cut: (t, max) => t.slice(0, Math.max(0, max - CUT.length)) + CUT };
var MIN_CAP_CHARS = 150;
var SUMMARY_SHARE = 0.3;
function sessionLines(c, budget) {
  const out = [];
  let room = budget;
  for (const s of c.compact_summaries ?? []) {
    const text = room === Infinity ? s.text : CHARS.size(s.text) > budget * SUMMARY_SHARE ? CHARS.cut(s.text, Math.floor(budget * SUMMARY_SHARE)) : s.text;
    out.push(`(Claude Code's summary of the conversation so far${s.ts ? `, ${s.ts.slice(0, 16)}` : ""}): ${text.replace(/\n{3,}/g, "\n\n")}`);
    room -= text.length;
  }
  const msgs = c.messages.map((m) => ({ ...m, text: m.text.replace(/\n{3,}/g, "\n\n") }));
  const fitted = fitTurns(msgs, room === Infinity ? Infinity : Math.max(room, MIN_CAP_CHARS * 4), CHARS, MIN_CAP_CHARS);
  const at = new Map(fitted.indices.map((i, k) => [i, fitted.kept[k]]));
  msgs.forEach((_, i) => {
    const m = at.get(i);
    if (m) out.push(`${m.role === "user" ? "> developer" : "< claude"}: ${m.text}`);
    else if (out[out.length - 1] !== OMITTED) out.push(OMITTED);
  });
  return out;
}
function split(lines) {
  const parts = [];
  let cur = "";
  let curBytes = 0;
  for (let l of lines) {
    let size = Buffer.byteLength(l, "utf8");
    if (size > PART_BYTES) {
      l = cutBytes(l, PART_BYTES - 40).text;
      size = Buffer.byteLength(l, "utf8");
    }
    if (curBytes + size + 1 > PART_BYTES) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += l + "\n";
    curBytes += size + 1;
  }
  if (cur) parts.push(cur);
  return parts;
}
function git2(cwd, args) {
  try {
    return (0, import_node_child_process4.execFileSync)("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CAPTURE.gitTimeoutMs,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }
    });
  } catch {
    return null;
  }
}
var dirs = (d) => {
  try {
    return (0, import_node_fs13.readdirSync)(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};
var files = (d) => {
  try {
    return (0, import_node_fs13.readdirSync)(d);
  } catch {
    return [];
  }
};

// src/standup/commands.ts
var H = 36e5;
var partsFile = () => (0, import_node_path16.join)(dataDir(), "standup-materials.json");
async function standupCommand(args, pluginRoot, now = /* @__PURE__ */ new Date()) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "prepare":
      return prepare(rest, pluginRoot, now);
    case "send":
      return send(rest.join(" "), now);
    case "snooze":
      return snooze(now);
    case "save-digests":
      return saveDigests(rest.join(" "));
    case "event": {
      const type = rest[0];
      if (!["edited", "blocker"].includes(type)) return { code: 1, out: "usage: standup event edited|blocker" };
      enqueueEvent(type, now);
      return { code: 0, out: "ok" };
    }
    default:
      return { code: 1, out: "usage: standup prepare [--part N] | send '<json>' | save-digests '<json>' | snooze | event edited|blocker" };
  }
}
async function captureFresh(from) {
  const state = readState();
  const jobs = findSessions({
    projectsDir: paths.claudeProjects(),
    repos: workRepos(state),
    sinceMs: from.getTime(),
    captures: state.captures ?? {},
    reason: "standup",
    max: CAPTURE.recoverMaxSessions
  });
  if (jobs.length > 0) await runCapture(jobs);
}
async function prepare(args, pluginRoot, now) {
  const partArg = args.indexOf("--part");
  const part = partArg >= 0 ? Number(args[partArg + 1]) : 1;
  if (!Number.isInteger(part) || part < 1) return { code: 1, out: "usage: standup prepare [--part N]" };
  let parts;
  if (part === 1) {
    const from = periodFrom(readState(), now);
    await captureFresh(from);
    const state = readState();
    const prompt = await standupPrompt(pluginRoot, now.getTime());
    parts = render(collect(from, now, workRepos(state)), prompt);
    writeFileAtomic(partsFile(), JSON.stringify(parts));
    updateState((s) => {
      s.standup = {
        ...s.standup,
        pending: { from: from.toISOString(), to: now.toISOString(), prompt_version: prompt.version },
        showing_until: new Date(now.getTime() + DEFAULTS.showLockMinutes * 6e4).toISOString(),
        // No answer (the user went straight to an emergency) = ask again later, like «Not now».
        snooze_until: new Date(now.getTime() + DEFAULTS.snoozeHours * H).toISOString()
      };
    });
    enqueueEvent("shown", now);
  } else {
    try {
      parts = JSON.parse((0, import_node_fs14.readFileSync)(partsFile(), "utf8"));
    } catch {
      return { code: 1, out: "No prepared materials: run standup prepare without --part first." };
    }
  }
  if (part > parts.length) return { code: 1, out: `There are only ${parts.length} parts.` };
  const header = parts.length > 1 ? `[Part ${part} of ${parts.length}${part < parts.length ? ` \u2014 next: standup prepare --part ${part + 1}` : ""}]
` : "";
  return { code: 0, out: header + parts[part - 1] };
}
var str2 = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : null;
function buildReport(input, pending, now) {
  const text = str2(input.text);
  if (!text) return "text is required \u2014 the standup exactly as the developer saw it";
  if (!Array.isArray(input.items)) return "items is required: [{ticket, branch, done, why, next}]";
  const items = [];
  for (const raw of input.items) {
    const i = raw ?? {};
    const done = str2(i.done);
    if (!done) return "every item needs a done field";
    items.push({ ticket: str2(i.ticket), branch: str2(i.branch), done, why: str2(i.why), next: str2(i.next) });
  }
  const blockers = Array.isArray(input.blockers) ? input.blockers.map(str2).filter((b) => b !== null) : [];
  return { id: (0, import_node_crypto3.randomUUID)(), date: localDate(now), period: { from: pending.from, to: pending.to }, items, blockers, text, prompt_version: pending.prompt_version };
}
async function send(json, now) {
  let input;
  try {
    input = JSON.parse(json);
  } catch {
    return { code: 1, out: "The argument must be JSON {text, items, blockers} in single quotes (replace apostrophes inside with \u2019)." };
  }
  const state = readState();
  const pending = state.standup?.pending ?? { from: periodFrom(state, now).toISOString(), to: now.toISOString(), prompt_version: "unknown" };
  const report = buildReport(input, pending, now);
  if (typeof report === "string") return { code: 1, out: report };
  enqueueReport(report);
  enqueueEvent("sent", now);
  updateState((s) => {
    s.last_checkin = report.period.to;
    s.standup = { done_date: localDate(now) };
  });
  const r = await flush(now.getTime());
  log("info", "standup: sent", { items: report.items.length, blockers: report.blockers.length, delivered: r.left === 0, stopped: r.stopped });
  if (r.left === 0) return { code: 0, out: "Sent to your manager." };
  if (r.stopped === "no_token") return { code: 0, out: "Saved. It will go to your manager once you join a team." };
  return { code: 0, out: "Saved, but the server is unreachable right now \u2014 it will be sent automatically next time Claude Code starts." };
}
function snooze(now) {
  const today = localDate(now);
  let skipped = false;
  updateState((s) => {
    const st = s.standup ?? {};
    const snoozes = (st.snooze_date === today ? st.snoozes ?? 0 : 0) + 1;
    skipped = snoozes >= 2;
    s.standup = skipped ? { done_date: today } : { ...st, snooze_date: today, snoozes, snooze_until: new Date(now.getTime() + DEFAULTS.snoozeHours * H).toISOString(), showing_until: void 0, pending: void 0 };
  });
  enqueueEvent(skipped ? "skipped" : "snoozed", now);
  return skipped ? { code: 0, out: "Skipping today. Today\u2019s work will go into tomorrow\u2019s standup." } : { code: 0, out: `OK, I\u2019ll remind you in ${DEFAULTS.snoozeHours} h at the earliest.` };
}
function saveDigests(json) {
  let list2;
  try {
    list2 = JSON.parse(json);
  } catch {
    return { code: 1, out: "The argument is a JSON array [{repo, branch, digest}] in single quotes (replace apostrophes inside with \u2019)." };
  }
  if (!Array.isArray(list2)) return { code: 1, out: "an array [{repo, branch, digest}] is required" };
  let saved = 0;
  const skipped = [];
  for (const raw of list2) {
    const d = raw ?? {};
    const repo = str2(d.repo);
    const branch = str2(d.branch);
    const digest = str2(d.digest);
    if (!repo || !branch || !digest || !REPO_ID_RE.test(repo)) {
      skipped.push(String(d.repo ?? "?"));
      continue;
    }
    writeDigest(repo, branch, digest);
    saved++;
  }
  log("info", "standup: digests saved", { saved, skipped: skipped.length });
  return { code: skipped.length && !saved ? 1 : 0, out: `Digests saved: ${saved}${skipped.length ? `; skipped (repo must be the repo_id from the materials): ${skipped.join(", ")}` : ""}` };
}

// src/hookio.ts
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function parseHookInput(raw) {
  const data = JSON.parse(raw);
  if (typeof data.session_id !== "string") throw new Error("hook input without session_id");
  return data;
}

// src/hooks/session-end.ts
var import_node_child_process5 = require("node:child_process");
function sessionEnd(input, cliPath) {
  const job = JSON.stringify({
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    reason: input.reason
  });
  (0, import_node_child_process5.spawn)(process.execPath, [cliPath, "capture", job], { detached: true, stdio: "ignore" }).unref();
}

// src/hooks/session-start.ts
var import_node_path17 = require("node:path");
var import_node_child_process6 = require("node:child_process");
var import_node_fs15 = require("node:fs");
function sessionStart(input, cliPath, now = /* @__PURE__ */ new Date()) {
  const outs = [];
  try {
    outs.push(newRepoCheck(input, cliPath));
  } catch (err) {
    log("error", "session-start: repo check failed", { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    const jobs = findMissedSessions(input);
    if (jobs.length > 0) {
      spawnCapture(cliPath, jobs);
      log("info", "session-start: recovering missed sessions", { count: jobs.length });
    }
  } catch (err) {
    log("error", "session-start: recovery failed", { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    outs.push(standupCheck(input, now));
    if (queueNotEmpty()) (0, import_node_child_process6.spawn)(process.execPath, [cliPath, "flush"], { detached: true, stdio: "ignore" }).unref();
  } catch (err) {
    log("error", "session-start: standup check failed", { error: err instanceof Error ? err.message : String(err) });
  }
  return merge(outs);
}
function standupCheck(input, now, state = readState()) {
  if (input.source === "compact") return null;
  const repos = workRepos(state);
  if (repos.length === 0 || gate(state, now) !== "ok") return null;
  const from = periodFrom(state, now);
  const hasWork = rawFilesSince(from.getTime()).length > 0 || outsideCommits(repos, from, /* @__PURE__ */ new Set(), 1).length > 0;
  if (!hasWork) {
    const today = localDate(now);
    if (state.standup?.no_work_date !== today) {
      enqueueEvent("no_work", now);
      updateState((s) => {
        s.standup = { ...s.standup, no_work_date: today };
      });
    }
    return null;
  }
  log("info", "standup: ready");
  return {
    systemMessage: "\u{1F4CB} Your standup is ready",
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `[Standup Agent] First session of the day: there is work since the last standup, so a standup draft can be put together.
Before doing what the user asks, call the Skill tool: skill \xABstandup-agent:standup\xBB, args \xABshow\xBB \u2014 and follow it to the end (show the standup and the question with 4 buttons). Only after the answer move on to the user's request.
Exception: if the user writes about an urgent incident, help first and offer the standup afterwards.
Talk to the user in their language.`
    }
  };
}
function queueNotEmpty() {
  try {
    return (0, import_node_fs15.readdirSync)(paths.queue()).some((f) => f.endsWith(".json") && !f.startsWith("."));
  } catch {
    return false;
  }
}
function merge(outs) {
  const msgs = outs.map((o) => o?.systemMessage).filter((m) => !!m);
  const ctx = outs.map((o) => o?.hookSpecificOutput?.additionalContext).filter((c) => !!c);
  if (msgs.length === 0 && ctx.length === 0) return null;
  const out = {};
  if (msgs.length) out.systemMessage = msgs.join("\n");
  if (ctx.length) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: ctx.join("\n\n") };
  return out;
}
function findMissedSessions(input, now = Date.now()) {
  const state = readState();
  return findSessions({
    projectsDir: projectsDirFor(input),
    repos: workRepos(state),
    sinceMs: now - CAPTURE.recoverLookbackDays * 864e5,
    captures: state.captures ?? {},
    exclude: input.session_id,
    reason: "recover",
    max: CAPTURE.recoverMaxSessions
  });
}
function projectsDirFor(input) {
  return input.transcript_path ? (0, import_node_path17.dirname)((0, import_node_path17.dirname)(input.transcript_path)) : paths.claudeProjects();
}
function newRepoCheck(input, cliPath, state = readState(), now = Date.now()) {
  if (!state.team) return null;
  const fresh = (r) => !!r && !state.repos?.[r.path] && !state.repos_asked?.[r.path];
  let repo = input.cwd ? repoOf(input.cwd) : null;
  let visited = false;
  if (!fresh(repo)) {
    repo = null;
    const seen = Object.entries(state.unmarked_seen ?? {}).sort((a, b) => b[1].last_seen.localeCompare(a[1].last_seen));
    for (const [path] of seen) {
      const r = repoOf(path);
      if (fresh(r) && r.path === path) {
        repo = r;
        visited = true;
        break;
      }
    }
    if (!repo) return null;
  }
  if (matchesWorkOrg(repo.remotes, state.team.work_orgs ?? [])) {
    const { becameWork, sessions } = setRepoKindsWithSessions({ [repo.path]: "work" });
    if (visited || Object.keys(sessions).length > 0) backfill(becameWork, cliPath, now, sessions);
    log("info", "repos: marked work by org", { repo: repo.name });
    return { systemMessage: `\u{1F4CB} Standup Agent: ${repo.name} belongs to your team\u2019s org \u2014 included in your standup` };
  }
  markRepoAsked(repo.path);
  log("info", "repos: asking about a new repo", { repo: repo.name, visited });
  return {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: askAboutRepo(repo, state.team.name, visited) }
  };
}
var sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
function askAboutRepo(repo, teamName, visited = false) {
  const where = repo.remotes[0] ? ` (${repo.remotes[0]})` : " (no remote)";
  const set2 = (kind) => `call the Skill tool: skill \xABstandup-agent:standup\xBB, args \xABrepos set ${sq(`${repo.path}=${kind}`)}\xBB`;
  const what = visited ? `In an earlier Claude Code session the user also worked in the repo ${repo.name}${where} (${repo.path}), which isn't marked yet` : `The user is working in the repo ${repo.name}${where} for the first time since joining the team${teamName ? ` \xAB${teamName}\xBB` : ""}`;
  return `[Standup Agent] ${what}. This question is asked once. Ask it in the user's language: the quoted texts below are English templates.

Before doing the user's first request, call AskUserQuestion: question \xABInclude ${repo.name} in your standup?\xBB, header \xABStandup\xBB, two options:
- \xABYes, it\u2019s work\xBB \u2014 description: work in this repo goes into your standup draft (your manager only sees what you confirm);
- \xABNo, personal\xBB \u2014 description: nothing from this repo is stored, not even locally.

Do one action based on the answer and don't come back to it:
- \xABYes, it\u2019s work\xBB: ${set2("work")}
- \xABNo, personal\xBB: ${set2("personal")}
If the user didn't answer or refused to choose, do nothing (the repo stays unmarked and isn't captured; it can be changed with /standup repos). Then move on to their request.`;
}

// src/cli.ts
async function main(argv) {
  if (argv[0] === "--data" && argv[1]) {
    process.env.CLAUDE_PLUGIN_DATA = argv[1];
    argv = argv.slice(2);
  }
  const [command, arg] = argv;
  const cliPath = process.argv[1] ?? __filename;
  try {
    switch (command) {
      case "session-start": {
        const out = sessionStart(parseHookInput(await readStdin()), cliPath);
        if (out) process.stdout.write(JSON.stringify(out));
        return 0;
      }
      case "session-end":
        sessionEnd(parseHookInput(await readStdin()), cliPath);
        return 0;
      case "capture":
        await runCapture(JSON.parse(arg ?? "{}"));
        return 0;
      case "repos": {
        const { code, out } = await reposCommand(argv.slice(1), cliPath);
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        return code;
      }
      case "standup": {
        const { code, out } = await standupCommand(argv.slice(1), (0, import_node_path18.dirname)((0, import_node_path18.dirname)(cliPath)));
        process.stdout.write(out + "\n");
        return code;
      }
      case "join-info":
      case "join":
      case "leave": {
        const { code, out } = command === "join-info" ? await joinInfo(arg ?? "") : command === "join" ? await joinTeam(arg ?? "", argv[2] ?? "", argv[3] ?? "") : await leave();
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        return code;
      }
      case "flush": {
        const r = await flush();
        if (r.sent > 0 || r.stopped === "auth") log("info", "queue: flush", { ...r });
        return 0;
      }
      default:
        log("error", "unknown command", { command });
        return 0;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log("error", "command failed", { command, error });
    if (["repos", "standup", "join", "join-info", "leave"].includes(command ?? "")) {
      process.stdout.write(JSON.stringify({ error }) + "\n");
      return 1;
    }
    return 0;
  }
}
if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  main
});
