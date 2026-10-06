// Sandboxed run_js: executes small pure-computation JS in an isolated child process.
// Threat model: docs/architecture.md "run_js sandbox 威胁模型"（REQ-SEC-0001）。
// Isolation layers:
// - child process (spawned via process.execPath, --smol) gets an EMPTY environment
//   (no secrets) and an isolated tmp cwd
// - code runs in a node:vm context built from Object.create(null) with
//   codeGeneration disabled: no host-realm object/function ever enters the context,
//   so the classic console.log.constructor / this.constructor.constructor escapes
//   have nothing to grab; eval/new Function inside user code is disabled too
// - console/logs are bootstrapped INSIDE the context; results cross the realm
//   boundary only as strings produced (and length-capped) inside the context
//   (primitives crossing realms are safe; object references never cross)
// - vm timeout only bounds SYNCHRONOUS code; async microtask blowups and unsettled
//   promises are bounded by the parent-side SIGKILL at TIMEOUT_MS
// - hard timeout; per-line / total log caps; the parent only ever forwards the
//   wrapper's structured JSON line — unparseable stdout becomes a fixed failure
// - on Linux with bubblewrap installed, the child additionally runs in fresh namespaces with no
//   network and a filesystem of read-only /usr, the interpreter and its own work dir only, so
//   even an engine-level vm escape cannot read the project, .env or the user's home
// Tests: test/sandbox.test.ts (must re-run after any change to the sandbox model).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TIMEOUT_MS = 5000; // parent-side SIGKILL backstop (covers async blowups)
const VM_TIMEOUT_MS = 3000; // vm timeout; only bounds synchronous execution
const MAX_OUTPUT = 4096;
const MAX_CODE = 16_000;
const MAX_LOG_LINE = 1024; // per console.log line, enforced inside the context
const MAX_ERROR = 1024; // error message, enforced inside the context
// Raw child stdout bound. The wrapper payload is ≤ ~9.3KB of text (logs 4096 + result 4096 +
// error 1024) before JSON escaping, which can expand up to 6x for control characters.
const MAX_RAW = 64 * 1024;

// Wrapper executed by the child bun. Protocol: exactly one JSON line on stdout —
// { ok, logs: string[], result?: string, error?: string } — no __RESULT__ marker,
// so user prints can never collide with the framing.
const WRAPPER = `
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(process.argv[2], "utf8");
const started = Date.now();

const sandbox = Object.create(null);
const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

// Bootstrap inside the context realm: console collects into an in-context array;
// __safe formats any value to a string without involving host-realm functions.
// Every string that leaves the context is bounded here, so the host never handles
// an unbounded payload.
vm.runInContext(\`
  const __logs = [];
  let __logsLen = 0;
  const __MAX = ${MAX_OUTPUT};
  const __MAX_LINE = ${MAX_LOG_LINE};
  globalThis.console = {
    log: (...a) => {
      if (__logsLen >= __MAX) return;
      let line = a.map(String).join(" ");
      if (line.length > __MAX_LINE) line = line.slice(0, __MAX_LINE) + "...(truncated)";
      __logs.push(line);
      __logsLen += line.length + 1;
    },
  };
  globalThis.__safe = (v) => {
    let s;
    if (v === undefined) s = "undefined";
    else if (typeof v === "string") s = v;
    else {
      try { s = JSON.stringify(v); if (s === undefined) s = String(v); }
      catch { s = String(v); }
    }
    return s.slice(0, ${MAX_OUTPUT});
  };
  globalThis.__errText = (e) => String(e && e.message ? e.message : e).slice(0, ${MAX_ERROR});
\`, ctx);

// Only primitives cross the realm boundary; anything else (a user-redefined helper
// returning an object) is replaced by a fixed string instead of being stringified here.
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "(unrepresentable)");
function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}
const readLogs = () => {
  const raw = vm.runInContext("JSON.stringify(__logs)", ctx);
  try {
    const parsed = JSON.parse(str(raw, ${MAX_RAW}));
    return Array.isArray(parsed) ? parsed.filter((l) => typeof l === "string") : [];
  } catch {
    return [];
  }
};

try {
  // The completion value may be a context-realm object: hand it straight back
  // into the context. The host never invokes its methods and never passes a
  // host value into the context, so no capability crosses realms.
  sandbox.__v = vm.runInContext(code, ctx, { timeout: ${VM_TIMEOUT_MS} });
  const isThenable = vm.runInContext(
    "__v !== null && (typeof __v === 'object' || typeof __v === 'function') && typeof __v.then === 'function'",
    ctx,
  );
  if (isThenable) {
    // Callbacks are created inside the context: no host function crosses realms.
    vm.runInContext(
      "__settled = null; Promise.resolve(__v).then(" +
        "(r) => { __settled = { ok: true, s: __safe(r) }; }," +
        "(e) => { __settled = { ok: false, s: __errText(e) }; });",
      ctx,
    );
    // Bounded wait; the parent-side SIGKILL is the ultimate backstop.
    const deadline = started + ${TIMEOUT_MS - 1000};
    let settledOk = null;
    let settledText = "";
    while (Date.now() < deadline) {
      const ok = vm.runInContext("__settled === null ? null : __settled.ok === true", ctx);
      if (ok !== null) {
        settledOk = ok;
        settledText = str(vm.runInContext("__settled.s", ctx), ${MAX_OUTPUT});
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const logs = readLogs();
    if (settledOk === null) emit({ ok: false, logs, error: "promise did not settle within time limit" });
    else if (settledOk) emit({ ok: true, logs, result: settledText });
    else emit({ ok: false, logs, error: settledText.slice(0, ${MAX_ERROR}) });
  } else {
    const result = str(vm.runInContext("__safe(__v)", ctx), ${MAX_OUTPUT});
    emit({ ok: true, logs: readLogs(), result });
  }
} catch (err) {
  // err is a context-realm object; stringify it inside the context.
  sandbox.__err = err;
  let message;
  try {
    message = str(vm.runInContext("__errText(__err)", ctx), ${MAX_ERROR});
  } catch {
    message = "(error could not be formatted)";
  }
  emit({ ok: false, logs: readLogs(), error: message });
}
`;

export const BWRAP = process.platform === "linux" ? Bun.which("bwrap") : null;

/** The child command: bubblewrap-confined when available, otherwise the plain interpreter. */
export function sandboxCommand(execPath: string, dir: string): { command: string; args: string[]; workDir: string } {
	const script = (workDir: string) => ["--smol", join(workDir, "wrapper.mjs"), join(workDir, "code.js")];
	if (!BWRAP) return { command: execPath, args: script(dir), workDir: dir };
	const interpreter = execPath.startsWith("/usr/") ? [] : ["--ro-bind", dirname(execPath), dirname(execPath)];
	return {
		command: BWRAP,
		args: [
			"--unshare-all",
			"--die-with-parent",
			"--new-session",
			"--clearenv",
			"--setenv",
			"PATH",
			"/usr/bin",
			"--ro-bind",
			"/usr",
			"/usr",
			"--symlink",
			"usr/lib",
			"/lib",
			"--symlink",
			"usr/lib64",
			"/lib64",
			"--symlink",
			"usr/bin",
			"/bin",
			...interpreter,
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--tmpfs",
			"/tmp",
			"--bind",
			dir,
			"/work",
			"--chdir",
			"/work",
			execPath,
			...script("/work"),
		],
		workDir: dir,
	};
}

export interface RunJsResult {
	ok: boolean;
	output: string; // console output + final expression value (or error message)
	durationMs: number;
}

export async function runJs(code: string, execPath: string = process.execPath): Promise<RunJsResult> {
	if (code.length > MAX_CODE)
		return { ok: false, output: `code too large (${code.length} > ${MAX_CODE})`, durationMs: 0 };
	const started = Date.now();
	const dir = mkdtempSync(join(tmpdir(), "runjs-"));
	try {
		writeFileSync(join(dir, "wrapper.mjs"), WRAPPER);
		writeFileSync(join(dir, "code.js"), code);
		return await new Promise<RunJsResult>((resolve) => {
			const sandbox = sandboxCommand(execPath, dir);
			const child = spawn(sandbox.command, sandbox.args, {
				cwd: sandbox.workDir,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, // empty except PATH: no secrets
				stdio: ["ignore", "pipe", "ignore"], // stderr (runtime crash dumps) never reaches the model
			});
			let out = "";
			const cap = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n...(truncated)` : s);
			child.stdout.on("data", (d: Buffer) => {
				out = cap(out + d.toString(), MAX_RAW);
			});
			const killer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve({ ok: false, output: `timeout after ${TIMEOUT_MS}ms`, durationMs: Date.now() - started });
			}, TIMEOUT_MS);
			child.on("error", (spawnErr) => {
				// e.g. ENOENT: interpreter missing — structured error, never uncaught
				clearTimeout(killer);
				resolve({
					ok: false,
					output: `failed to spawn sandbox interpreter: ${spawnErr.message}`,
					durationMs: Date.now() - started,
				});
			});
			child.on("close", (codeNum) => {
				clearTimeout(killer);
				const durationMs = Date.now() - started;
				let msg: { ok: boolean; logs?: string[]; result?: string; error?: string } | null = null;
				try {
					msg = JSON.parse(out.trim());
				} catch {
					// wrapper died before emitting its JSON line (killed, crashed, OOM, ...) or the
					// line was truncated: never hand raw/partial stdout or stderr to the model
					msg = null;
				}
				if (!msg || typeof msg !== "object") {
					resolve({
						ok: false,
						output: `sandbox exited without a structured result (exit code ${codeNum ?? "unknown"})`,
						durationMs,
					});
					return;
				}
				const logs = (Array.isArray(msg.logs) ? msg.logs : []).join("\n");
				const body = msg.ok
					? [logs, msg.result ?? ""].filter(Boolean).join("\n")
					: [logs, msg.error ?? "unknown error"].filter(Boolean).join("\n");
				resolve({ ok: Boolean(msg.ok), output: cap(body, MAX_OUTPUT), durationMs });
			});
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
