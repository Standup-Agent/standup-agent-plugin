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

// src/log.ts
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");

// src/paths.ts
var import_node_os = require("node:os");
var import_node_path = require("node:path");
function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA ?? (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude", "plugins", "data", "standup-agent-dev");
}
var paths = {
  state: () => (0, import_node_path.join)(dataDir(), "state.json"),
  auth: () => (0, import_node_path.join)(dataDir(), "auth.json"),
  digests: () => (0, import_node_path.join)(dataDir(), "digests"),
  queue: () => (0, import_node_path.join)(dataDir(), "queue"),
  logDir: () => (0, import_node_path.join)(dataDir(), "log")
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

// src/capture/worker.ts
async function runCapture(job) {
  log("info", "capture: not implemented yet", { session: job.session_id.slice(0, 8), reason: job.reason });
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
var import_node_child_process = require("node:child_process");
function sessionEnd(input, cliPath) {
  const job = JSON.stringify({
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    reason: input.reason
  });
  (0, import_node_child_process.spawn)(process.execPath, [cliPath, "capture", job], { detached: true, stdio: "ignore" }).unref();
}

// src/hooks/session-start.ts
function sessionStart(_input) {
  return null;
}

// src/cli.ts
async function main(argv) {
  const [command, arg] = argv;
  try {
    switch (command) {
      case "session-start": {
        const out = sessionStart(parseHookInput(await readStdin()));
        if (out) process.stdout.write(JSON.stringify(out));
        return 0;
      }
      case "session-end":
        sessionEnd(parseHookInput(await readStdin()), process.argv[1] ?? __filename);
        return 0;
      case "capture":
        await runCapture(JSON.parse(arg ?? "{}"));
        return 0;
      default:
        log("error", "unknown command", { command });
        return 0;
    }
  } catch (err) {
    log("error", "command failed", { command, error: err instanceof Error ? err.message : String(err) });
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
