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

// src/capture/worker.ts
var import_node_fs6 = require("node:fs");
var import_node_path7 = require("node:path");

// src/config.ts
var DEFAULTS = {
  /** Raw session capture is kept locally this long, then deleted. */
  rawTtlDays: 30,
  /** Soft cap on text taken from one session transcript. */
  rawMaxBytesPerSession: 64 * 1024,
  /** Standup is not shown before this local hour. */
  showNotBeforeHour: 6,
  /** "Не сейчас" postpones the standup for this long. */
  snoozeHours: 2,
  /** Another terminal won't show the standup while one is showing it. */
  showLockMinutes: 10,
  /** Repo scan window when joining a team. */
  repoScanDays: 30,
  /** Transcripts re-captured right after join, to show a first standup immediately. */
  joinBackfillDays: 3
};
var CAPTURE = {
  /** One message longer than this is cut; keeps a pasted log from eating the session budget. */
  maxBytesPerMessage: 8 * 1024,
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
var API_BASE_URL = process.env.STANDUP_AGENT_API_URL ?? "https://standupagent.ai/api";

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
function setRepoKinds(kinds) {
  const becameWork = [];
  updateState((s) => {
    const repos = { ...s.repos ?? {} };
    for (const [path, kind] of Object.entries(kinds)) {
      if (kind === "work" && repos[path] !== "work") becameWork.push(path);
      repos[path] = kind;
    }
    s.repos = repos;
  });
  return becameWork;
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
function rawPath(repoPath, branch, sessionId) {
  return (0, import_node_path5.join)(paths.digests(), repoKey(repoPath), branchKey(branch), "raw", `${safeFile(sessionId)}.json`);
}
function writeRaw(capture, now = /* @__PURE__ */ new Date()) {
  const file = rawPath(capture.repo.path, capture.branch, capture.session_id);
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
  const files = /* @__PURE__ */ new Set();
  for (const c of commits) for (const f of c.files) files.add(f);
  if (currentBranch(root) === branch) for (const f of uncommittedFiles(root)) files.add(f);
  return {
    branch,
    commits,
    files: [...files].slice(0, CAPTURE.maxFilesPerBranch),
    tickets: findTickets(branch, ...commits.map((c) => c.message))
  };
}
function uncommittedFiles(root) {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  if (!out) return [];
  const files = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    files.push(p.slice(3));
    if (p[0] === "R" || p[0] === "C") i++;
  }
  return files;
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
  "pr-link"
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
  const out = { messages: [], dropped: 0, cut: 0 };
  const unknown = {};
  let badLines = 0;
  let branch;
  const hardCap = Math.max(opts.maxBytes, opts.maxBytesPerMessage);
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
    const type = str(entry.type) ?? "";
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
      out.messages.push(msg);
    }
  }
  applyBudget(out, opts.maxBytes);
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
function applyBudget(t, maxBytes) {
  const size = (m) => Buffer.byteLength(m.text, "utf8");
  const total = t.messages.reduce((n, m) => n + size(m), 0);
  if (total <= maxBytes) return;
  const firstUser = t.messages.findIndex((m) => m.role === "user");
  const keep = /* @__PURE__ */ new Set();
  let used = 0;
  if (firstUser >= 0) {
    keep.add(firstUser);
    used += size(t.messages[firstUser]);
  }
  for (let i = t.messages.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    const s = size(t.messages[i]);
    if (used + s > maxBytes) break;
    keep.add(i);
    used += s;
  }
  const kept = t.messages.filter((_, i) => keep.has(i));
  t.dropped += t.messages.length - kept.length;
  t.messages = kept;
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
  const cwd = job.cwd ?? await readTranscriptCwd(job.transcript_path);
  if (!cwd) return done("no cwd");
  const root = repoRoot(cwd);
  if (!root) return done("not a git repo");
  const repo = markedWorkRepo(root, readState());
  if (!repo) return done("repo is not marked as work");
  const redacted = {};
  const transcript = await readTranscript(job.transcript_path, {
    maxBytes: DEFAULTS.rawMaxBytesPerSession,
    maxBytesPerMessage: CAPTURE.maxBytesPerMessage,
    transform: (text) => {
      const r = redactSecrets(text);
      addFound(redacted, r.found);
      return r.text;
    }
  });
  const fallbackBranch = currentBranch(root) ?? "HEAD";
  const fallbackTs = new Date(mtimeMs).toISOString();
  let written = 0;
  let commits = 0;
  for (const [branch, messages] of groupByBranch(transcript.messages, fallbackBranch)) {
    const times = messages.map((m) => m.ts).filter((t) => !!t).sort((a, b) => Date.parse(a) - Date.parse(b));
    const from = times[0] ?? transcript.firstTs ?? fallbackTs;
    const to = times[times.length - 1] ?? transcript.lastTs ?? fallbackTs;
    const until = new Date(new Date(to).getTime() + CAPTURE.commitSlackMinutes * 6e4);
    const activity = branchActivity(root, branch, new Date(from), until);
    if (messages.length === 0 && activity.commits.length === 0) continue;
    const capture = {
      schema: 1,
      session_id: job.session_id,
      repo: { path: repo, name: (0, import_node_path7.basename)(repo) },
      branch,
      captured_at: now.toISOString(),
      period: { from, to },
      cc_version: transcript.version,
      reason: job.reason,
      messages: messages.map((m) => ({ role: m.role, ts: m.ts, text: m.text })),
      truncated: { dropped: transcript.dropped, cut: transcript.cut },
      commits: activity.commits.map((c) => {
        const r = redactSecrets(c.message);
        addFound(redacted, r.found);
        return { sha: c.sha, ts: c.ts, message: cutBytes(r.text, CAPTURE.maxCommitMessageBytes).text };
      }),
      files: activity.files,
      tickets: activity.tickets,
      redacted: {}
    };
    capture.redacted = { ...redacted };
    writeRaw(capture, now);
    written++;
    commits += capture.commits.length;
  }
  recordCapture(job.session_id, mtimeMs, now);
  log("info", "capture: done", {
    session,
    reason: job.reason,
    repo: (0, import_node_path7.basename)(repo),
    branches: written,
    messages: transcript.messages.length,
    commits,
    dropped: transcript.dropped,
    redacted
  });
}
function markedWorkRepo(root, state) {
  if (isWorkRepo(root, state)) return root;
  const main2 = mainWorktreeRoot(root);
  return main2 && isWorkRepo(main2, state) ? main2 : null;
}
function groupByBranch(messages, fallback) {
  const groups = /* @__PURE__ */ new Map();
  for (const m of messages) {
    const b = m.branch && m.branch !== "HEAD" ? m.branch : fallback;
    let list2 = groups.get(b);
    if (!list2) groups.set(b, list2 = []);
    list2.push(m);
  }
  if (groups.size === 0) groups.set(fallback, []);
  return groups;
}

// src/commands/repos.ts
var import_node_path10 = require("node:path");

// src/capture/discover.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs7 = require("node:fs");
var import_node_path8 = require("node:path");
function projectDirName(path) {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}
function findSessions(o) {
  const dirs = o.repos.map(projectDirName);
  if (dirs.length === 0) return [];
  const found = [];
  for (const dir of safeReaddir(o.projectsDir)) {
    if (!dirs.some((r) => dir === r || dir.startsWith(`${r}-`))) continue;
    for (const file of safeReaddir((0, import_node_path8.join)(o.projectsDir, dir))) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = (0, import_node_path8.basename)(file, ".jsonl");
      if (sessionId === o.exclude) continue;
      const path = (0, import_node_path8.join)(o.projectsDir, dir, file);
      let mtime;
      try {
        mtime = (0, import_node_fs7.statSync)(path).mtimeMs;
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
    return (0, import_node_fs7.readdirSync)(dir);
  } catch {
    return [];
  }
}

// src/repos.ts
var import_node_fs8 = require("node:fs");
var import_node_path9 = require("node:path");
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
  if (!(0, import_node_fs8.existsSync)(cwd)) return null;
  const root = repoRoot(cwd);
  if (!root) return null;
  const path = mainWorktreeRoot(root) ?? root;
  const remotes = [...new Set(gitConfigRemotes(path).map(normalizeRemote).filter((r) => r !== null))];
  return { path, name: (0, import_node_path9.basename)(path), remotes };
}
async function scanRepos(projectsDir, days, now = Date.now()) {
  const floor = now - days * 864e5;
  const byPath = /* @__PURE__ */ new Map();
  for (const dir of safeReaddir2(projectsDir)) {
    const newest = newestTranscript((0, import_node_path9.join)(projectsDir, dir), floor);
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
    const path = (0, import_node_path9.join)(dir, f);
    try {
      const mtime = (0, import_node_fs8.statSync)(path).mtimeMs;
      if (mtime >= floor && (!best || mtime > best.mtime)) best = { path, mtime };
    } catch {
    }
  }
  return best;
}
function safeReaddir2(dir) {
  try {
    return (0, import_node_fs8.readdirSync)(dir);
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
    const becameWork = setRepoKinds(Object.fromEntries(found.autoWork.map((r) => [r.path, "work"])));
    backfill(becameWork, cliPath, now);
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
    if (eq <= 0 || !(0, import_node_path10.isAbsolute)(path) || kind !== "work" && kind !== "personal") {
      return { code: 1, out: { error: `expected <absolute path>=work|personal, got: ${p}` } };
    }
    kinds[repoOf(path)?.path ?? path] = kind;
  }
  if (Object.keys(kinds).length === 0) return { code: 1, out: { error: "nothing to set" } };
  const becameWork = setRepoKinds(kinds);
  const backfilled = backfill(becameWork, cliPath, now);
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
function backfill(repos, cliPath, now) {
  if (repos.length === 0) return 0;
  const jobs = findSessions({
    projectsDir: paths.claudeProjects(),
    repos,
    sinceMs: now - DEFAULTS.joinBackfillDays * 864e5,
    reason: "backfill",
    max: CAPTURE.backfillMaxSessions
  });
  spawnCapture(cliPath, jobs);
  return jobs.length;
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
var import_node_child_process3 = require("node:child_process");
function sessionEnd(input, cliPath) {
  const job = JSON.stringify({
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    reason: input.reason
  });
  (0, import_node_child_process3.spawn)(process.execPath, [cliPath, "capture", job], { detached: true, stdio: "ignore" }).unref();
}

// src/hooks/session-start.ts
var import_node_path11 = require("node:path");
function sessionStart(input, cliPath) {
  let out = null;
  try {
    out = newRepoCheck(input, cliPath);
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
  return input.transcript_path ? (0, import_node_path11.dirname)((0, import_node_path11.dirname)(input.transcript_path)) : paths.claudeProjects();
}
function newRepoCheck(input, cliPath, state = readState()) {
  if (!state.team || !input.cwd) return null;
  const repo = repoOf(input.cwd);
  if (!repo || state.repos?.[repo.path] || state.repos_asked?.[repo.path]) return null;
  if (matchesWorkOrg(repo.remotes, state.team.work_orgs ?? [])) {
    setRepoKinds({ [repo.path]: "work" });
    log("info", "repos: marked work by org", { repo: repo.name });
    return { systemMessage: `\u{1F4CB} Standup Agent: ${repo.name} \u2014 \u0440\u0435\u043F\u043E \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0446\u0438\u0438 \u043A\u043E\u043C\u0430\u043D\u0434\u044B, \u0432\u043A\u043B\u044E\u0447\u0451\u043D \u0432 \u0441\u0442\u0435\u043D\u0434\u0430\u043F` };
  }
  markRepoAsked(repo.path);
  log("info", "repos: asking about a new repo", { repo: repo.name });
  return {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: askAboutRepo(repo, cliPath, state.team.name) }
  };
}
var sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
function cliCommand(cliPath, args) {
  return `CLAUDE_PLUGIN_DATA=${sq(dataDir())} node ${sq(cliPath)} ${args}`;
}
function askAboutRepo(repo, cliPath, teamName) {
  const where = repo.remotes[0] ? ` (${repo.remotes[0]})` : " (\u0431\u0435\u0437 remote)";
  const set2 = (kind) => cliCommand(cliPath, `repos set ${sq(`${repo.path}=${kind}`)}`);
  return `[Standup Agent] \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C \u0432\u043F\u0435\u0440\u0432\u044B\u0435 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0432 \u0440\u0435\u043F\u043E ${repo.name}${where} \u0441 \u0442\u0435\u0445 \u043F\u043E\u0440, \u043A\u0430\u043A \u0432\u0441\u0442\u0443\u043F\u0438\u043B \u0432 \u043A\u043E\u043C\u0430\u043D\u0434\u0443${teamName ? ` \xAB${teamName}\xBB` : ""}. \u042D\u0442\u043E\u0442 \u0432\u043E\u043F\u0440\u043E\u0441 \u0437\u0430\u0434\u0430\u0451\u0442\u0441\u044F \u043E\u0434\u0438\u043D \u0440\u0430\u0437.

\u041F\u0440\u0435\u0436\u0434\u0435 \u0447\u0435\u043C \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0442\u044C \u043F\u0435\u0440\u0432\u0443\u044E \u043F\u0440\u043E\u0441\u044C\u0431\u0443 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F, \u0432\u044B\u0437\u043E\u0432\u0438 AskUserQuestion: \u0432\u043E\u043F\u0440\u043E\u0441 \xAB\u0412\u043A\u043B\u044E\u0447\u0430\u0442\u044C \u0440\u0435\u043F\u043E ${repo.name} \u0432 \u0441\u0442\u0435\u043D\u0434\u0430\u043F?\xBB, header \xAB\u0421\u0442\u0435\u043D\u0434\u0430\u043F\xBB, \u0434\u0432\u0435 \u043E\u043F\u0446\u0438\u0438:
- \xAB\u0414\u0430, \u0440\u0430\u0431\u043E\u0447\u0438\u0439\xBB \u2014 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435: \u0440\u0430\u0431\u043E\u0442\u0430 \u0432 \u044D\u0442\u043E\u043C \u0440\u0435\u043F\u043E \u043F\u043E\u043F\u0430\u0434\u0451\u0442 \u0432 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u0441\u0442\u0435\u043D\u0434\u0430\u043F\u0430 (\u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440 \u0432\u0438\u0434\u0438\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0442\u043E, \u0447\u0442\u043E \u0442\u044B \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0448\u044C);
- \xAB\u041D\u0435\u0442, \u043B\u0438\u0447\u043D\u044B\u0439\xBB \u2014 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435: \u043D\u0438\u0447\u0435\u0433\u043E \u0438\u0437 \u044D\u0442\u043E\u0433\u043E \u0440\u0435\u043F\u043E \u043D\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442\u0441\u044F \u0434\u0430\u0436\u0435 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E.

\u041F\u043E \u043E\u0442\u0432\u0435\u0442\u0443 \u0432\u044B\u043F\u043E\u043B\u043D\u0438 \u043E\u0434\u043D\u0443 \u043A\u043E\u043C\u0430\u043D\u0434\u0443 \u0447\u0435\u0440\u0435\u0437 Bash \u0438 \u0431\u043E\u043B\u044C\u0448\u0435 \u043A \u044D\u0442\u043E\u043C\u0443 \u043D\u0435 \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0439\u0441\u044F:
- \xAB\u0414\u0430, \u0440\u0430\u0431\u043E\u0447\u0438\u0439\xBB: ${set2("work")}
- \xAB\u041D\u0435\u0442, \u043B\u0438\u0447\u043D\u044B\u0439\xBB: ${set2("personal")}
\u0415\u0441\u043B\u0438 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B \u0438\u043B\u0438 \u043E\u0442\u043A\u0430\u0437\u0430\u043B\u0441\u044F \u0432\u044B\u0431\u0438\u0440\u0430\u0442\u044C \u2014 \u043D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0439 (\u0440\u0435\u043F\u043E \u043E\u0441\u0442\u0430\u043D\u0435\u0442\u0441\u044F \u043D\u0435\u0440\u0430\u0437\u043C\u0435\u0447\u0435\u043D\u043D\u044B\u043C \u0438 \u043D\u0435 \u0431\u0443\u0434\u0435\u0442 \u0437\u0430\u0445\u0432\u0430\u0442\u044B\u0432\u0430\u0442\u044C\u0441\u044F; \u043F\u043E\u043C\u0435\u043D\u044F\u0442\u044C \u043C\u043E\u0436\u043D\u043E \u0447\u0435\u0440\u0435\u0437 /standup repos). \u041F\u043E\u0441\u043B\u0435 \u044D\u0442\u043E\u0433\u043E \u043F\u0435\u0440\u0435\u0445\u043E\u0434\u0438 \u043A \u0435\u0433\u043E \u043F\u0440\u043E\u0441\u044C\u0431\u0435.`;
}

// src/cli.ts
async function main(argv) {
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
      default:
        log("error", "unknown command", { command });
        return 0;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log("error", "command failed", { command, error });
    if (command === "repos") {
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
