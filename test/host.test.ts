/**
 * The host extension: what pi loads. Wiring only; decisions are tested in guard.test.ts.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { registerRules } from "../extensions/governor/client.ts";
import governorHost, { createGovernorHost } from "../extensions/governor/host.ts";
import type { RequiredChildHook } from "../extensions/governor/children.ts";
import { hostCount, isCovered, livePacks, PENDING, REGISTRY } from "../extensions/governor/registry.ts";
import type { LiveTool } from "../extensions/governor/rules.ts";

const g = globalThis as unknown as Record<symbol, unknown>;
const saved = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;
let projectDir: string;
beforeEach(() => {
	delete g[REGISTRY];
	delete g[PENDING];
	agentDir = mkdtempSync(join(tmpdir(), "governor-host-agent-"));
	projectDir = mkdtempSync(join(tmpdir(), "governor-host-project-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
	delete g[REGISTRY];
	delete g[PENDING];
	if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

const src = (path: string) => ({ path, source: "x", scope: "user", origin: "top-level" }) as LiveTool["sourceInfo"];
const WRITE: LiveTool = { name: "mcp__t__create_issue", namespace: { name: "mcp__t" }, annotations: { readOnlyHint: false }, sourceInfo: src("builtin:mcp") };
const READ: LiveTool = { name: "mcp__t__get_issue", namespace: { name: "mcp__t" }, annotations: { readOnlyHint: true }, sourceInfo: src("builtin:mcp") };
const BASH: LiveTool = { name: "bash", sourceInfo: src("builtin:bash") };

function fakePi(tools: LiveTool[] = [WRITE, READ, BASH]) {
	const handlers: Record<string, Array<(e: any, c: any) => any>> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	return {
		handlers,
		commands,
		on(event: string, handler: (e: any, c: any) => any) {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands[name] = options;
		},
		getAllTools: () => tools,
	};
}
const asPi = (p: ReturnType<typeof fakePi>) => p as unknown as Parameters<typeof governorHost>[0];
const session = {};
const ctx = (hasUI = false, answer = true) => ({
	sessionManager: session,
	cwd: projectDir,
	hasUI,
	ui: { confirm: async () => answer },
});
const emit = async (pi: ReturnType<typeof fakePi>, event: string, e: any, c: any = ctx()) => {
	let last: any;
	for (const h of pi.handlers[event] ?? []) last = (await h(e, c)) ?? last;
	return last;
};
/** The host as tests load it: never the real pi-subagents, unless a test passes a hook. */
const host = (p: ReturnType<typeof fakePi>, loadChildHook: (specs: string[]) => Promise<RequiredChildHook | undefined> = async () => undefined) => createGovernorHost(asPi(p), { loadChildHook });
const call = (toolName: string, extra: object = {}) => ({ toolName, toolCallId: "c1", input: {}, ...extra });

test("package.json loads the host, and the host's default export is a function", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.deepEqual(pkg.pi.extensions, ["./extensions/governor/host.ts"]);
	assert.equal(typeof governorHost, "function");
	assert.equal(governorHost.length, 1, "the default export takes only pi");
});

test("loading publishes the store and installs the handlers", () => {
	const pi = fakePi();
	host(pi);
	assert.equal(hostCount(), 1);
	for (const event of ["session_start", "tool_call", "tool_execution_start", "tool_execution_end", "session_shutdown"]) {
		assert.equal(pi.handlers[event]?.length, 1, event);
	}
	assert.deepEqual(Object.keys(pi.commands), ["governor"]);
});

test("/governor reports the live state through the UI", async () => {
	writeFileSync(join(agentDir, "governor.json"), "{ nope");
	const pi = fakePi();
	registerRules(asPi(pi) as any, { id: "p", rules: [{ tool: { server: "t", tool: "create_issue" }, verdict: "ask" }], whenNoHost: "block" });
	host(pi);
	await emit(pi, "session_start", {});
	const notes: Array<[string, string | undefined]> = [];
	await pi.commands.governor!.handler("", { ...ctx(), ui: { notify: (m: string, t?: string) => notes.push([m, t]) } });
	assert.equal(notes.length, 1);
	assert.match(notes[0]![0], /This session has a governor handler/);
	assert.match(notes[0]![0], /IS BROKEN/);
	assert.match(notes[0]![0], /p: 1 rule/);
	assert.match(notes[0]![0], /Subagent children: not known/);
});

test("/governor still answers when building the status fails", async () => {
	const pi = fakePi();
	host(pi);
	(pi as any).getAllTools = () => {
		throw new Error("tool list unavailable");
	};
	const notes: string[] = [];
	await pi.commands.governor!.handler("", { ...ctx(), ui: { notify: (m: string) => notes.push(m) } });
	assert.match(notes[0]!, /could not build its status: tool list unavailable/);
});

test("session_start marks the session covered; shutdown ends the store", async () => {
	const pi = fakePi();
	host(pi);
	assert.equal(isCovered(session), false);
	await emit(pi, "session_start", {});
	assert.equal(isCovered(session), true);
	await emit(pi, "session_shutdown", {});
	assert.equal(hostCount(), 0);
});

test("a registered package's rules are applied to real calls", async () => {
	const pi = fakePi();
	registerRules(asPi(pi) as any, { id: "p", rules: [{ tool: { server: "t", tool: "get_issue" }, verdict: "never" }], whenNoHost: "block" });
	host(pi);
	await emit(pi, "session_start", {});
	assert.equal(livePacks().length, 1);
	assert.equal((await emit(pi, "tool_call", call(READ.name)))?.block, true, "never beats readOnlyHint");
	assert.equal(await emit(pi, "tool_call", call(BASH.name)), undefined);
	assert.equal((await emit(pi, "tool_call", call(WRITE.name)))?.block, true, "no UI: blocked");
	assert.equal(await emit(pi, "tool_call", call(WRITE.name), ctx(true, true)), undefined, "approved in a UI");
});

test("the pack's own handler stands down in a covered session", async () => {
	const pi = fakePi();
	registerRules(asPi(pi) as any, { id: "p", rules: [{ tool: { server: "t", tool: "create_issue" }, verdict: "ask" }], whenNoHost: () => ({ block: true, reason: "fallback" }) });
	host(pi);
	await emit(pi, "session_start", {});
	const r = await emit(pi, "tool_call", call(WRITE.name), ctx(true, true));
	assert.equal(r, undefined, "the host asked and the user approved; the fallback did not run");
});

test("tool_execution_start and end drive trustedParents, and parentToolCallId is forwarded", async () => {
	const pi = fakePi();
	registerRules(asPi(pi) as any, { id: "p", rules: [{ tool: { server: "t", tool: "create_issue" }, verdict: "ask", trustedParents: ["confirmed"] }], whenNoHost: "block" });
	host(pi);
	await emit(pi, "session_start", {});
	await emit(pi, "tool_execution_start", { toolCallId: "p1", toolName: "confirmed" });
	assert.equal(await emit(pi, "tool_call", call(WRITE.name, { toolCallId: "p1/1", parentToolCallId: "p1" })), undefined);
	await emit(pi, "tool_execution_end", { toolCallId: "p1" });
	assert.equal((await emit(pi, "tool_call", call(WRITE.name, { toolCallId: "p1/2", parentToolCallId: "p1" })))?.block, true);
	assert.equal((await emit(pi, "tool_call", call(WRITE.name, { toolCallId: "p9/1" })))?.block, true, "no parent: not trusted");
});

test("governor.json in the agent dir sets source defaults; the project file can only tighten", async () => {
	writeFileSync(join(agentDir, "governor.json"), JSON.stringify({ defaults: { builtin: "ask", mcp: "allow" } }));
	mkdirSync(join(projectDir, ".pi"));
	writeFileSync(join(projectDir, ".pi", "governor.json"), JSON.stringify({ defaults: { mcp: "hints", extension: "never" } }));
	const pi = fakePi([WRITE, BASH, { name: "mine", sourceInfo: src("/x.ts") }]);
	host(pi);
	await emit(pi, "session_start", {});
	assert.equal((await emit(pi, "tool_call", call("bash")))?.block, true, "builtin: ask, no UI");
	assert.equal((await emit(pi, "tool_call", call("mine")))?.block, true, "extension: never from the project file");
	assert.equal((await emit(pi, "tool_call", call(WRITE.name)))?.block, true, "mcp: allow tightened to hints, and the tool has no read hint");
});

test("a broken governor.json makes every source ask", async () => {
	writeFileSync(join(agentDir, "governor.json"), "{ not json");
	const pi = fakePi();
	host(pi);
	await emit(pi, "session_start", {});
	assert.equal((await emit(pi, "tool_call", call("bash")))?.block, true);
	assert.equal((await emit(pi, "tool_call", call(READ.name)))?.block, true);
});

test("a governor.json that cannot be read as a file makes every source ask", async () => {
	mkdirSync(join(agentDir, "governor.json"));
	const pi = fakePi();
	host(pi);
	await emit(pi, "session_start", {});
	assert.equal((await emit(pi, "tool_call", call("bash")))?.block, true, "a directory in place of the file is not 'missing'");
});

test("no governor.json at all leaves the shipped defaults", async () => {
	const pi = fakePi();
	host(pi);
	await emit(pi, "session_start", {});
	assert.equal(await emit(pi, "tool_call", call("bash")), undefined);
	assert.equal(await emit(pi, "tool_call", call(READ.name)), undefined);
	assert.equal((await emit(pi, "tool_call", call(WRITE.name)))?.block, true);
});

test("a tool_call before session_start uses the shipped defaults, and still blocks an unannotated write", async () => {
	const pi = fakePi();
	host(pi);
	assert.equal((await emit(pi, "tool_call", call(WRITE.name)))?.block, true);
});

test("freezeArguments: calls the host lets through are frozen by default, and not when the global file turns it off", async () => {
	const pi = fakePi();
	host(pi);
	await emit(pi, "session_start", {});
	const input = { path: "a" };
	assert.equal(await emit(pi, "tool_call", { toolName: "bash", toolCallId: "c1", input }), undefined);
	assert.equal(Object.isFrozen(input), true);

	delete g[REGISTRY];
	writeFileSync(join(agentDir, "governor.json"), JSON.stringify({ freezeArguments: false }));
	const pi2 = fakePi();
	host(pi2);
	await emit(pi2, "session_start", {});
	const loose = { path: "a" };
	assert.equal(await emit(pi2, "tool_call", { toolName: "bash", toolCallId: "c2", input: loose }), undefined);
	assert.equal(Object.isFrozen(loose), false);
});

test("freezeArguments: a project file cannot turn freezing off", async () => {
	mkdirSync(join(projectDir, ".pi"));
	writeFileSync(join(projectDir, ".pi", "governor.json"), JSON.stringify({ freezeArguments: false }));
	const pi = fakePi();
	host(pi);
	await emit(pi, "session_start", {});
	const input = { path: "a" };
	await emit(pi, "tool_call", { toolName: "bash", toolCallId: "c1", input });
	assert.equal(Object.isFrozen(input), true);
});

test("/governor shows whether freezing is on", async () => {
	const pi = fakePi();
	host(pi);
	await emit(pi, "session_start", {});
	const notes: string[] = [];
	await pi.commands.governor!.handler("", { ...ctx(), ui: { notify: (m: string) => notes.push(m) } });
	assert.match(notes[0]!, /Argument freezing: ON \(the default\)/);
});

// ---- /governor revoke ------------------------------------------------------------------------

async function approvedHost(answer = true) {
	const pi = fakePi();
	registerRules(asPi(pi) as any, { id: "p", rules: [{ tool: { server: "t", tool: "create_issue" }, verdict: "ask", windowMs: 60_000 }], whenNoHost: "block" });
	host(pi);
	await emit(pi, "session_start", {});
	const c = ctx(true, answer);
	assert.equal(await emit(pi, "tool_call", call(WRITE.name), c), undefined);
	return { pi, c };
}
const notifier = () => {
	const notes: Array<[string, string | undefined]> = [];
	return { notes, ui: { notify: (m: string, t?: string) => notes.push([m, t]) } };
};

test("/governor revoke drops live approvals, says how many, and the next call asks again", async () => {
	const { pi } = await approvedHost();
	let asked = 0;
	const c = { ...ctx(true), ui: { confirm: async () => (asked++, true) } };
	assert.equal(await emit(pi, "tool_call", call(WRITE.name), c), undefined);
	assert.equal(asked, 0, "inside the window");
	const n = notifier();
	await pi.commands.governor!.handler("revoke", { ...ctx(), ui: n.ui });
	assert.deepEqual(n.notes.map((x) => x[0]), ["pi-governor: revoked 1 live approval. The next matching call asks again."]);
	assert.equal(await emit(pi, "tool_call", call(WRITE.name), c), undefined);
	assert.equal(asked, 1, "asks again after revoke");
});

test("/governor revoke with nothing live says so; surrounding spaces are ignored", async () => {
	const pi = fakePi();
	host(pi);
	const n = notifier();
	await pi.commands.governor!.handler("  revoke ", { ...ctx(), ui: n.ui });
	assert.deepEqual(n.notes.map((x) => x[0]), ["pi-governor: no live approvals to revoke."]);
});

test("/governor with an unknown argument prints usage, not the status, and revokes nothing", async () => {
	const { pi } = await approvedHost();
	const n = notifier();
	await pi.commands.governor!.handler("revoke now\x1b[2J", { ...ctx(), ui: n.ui });
	await pi.commands.governor!.handler("reset", { ...ctx(), ui: n.ui });
	assert.equal(n.notes.length, 2);
	for (const [text, type] of n.notes) {
		assert.match(text, /unknown argument/);
		assert.match(text, /Usage: \/governor \(status\) or \/governor revoke/);
		assert.doesNotMatch(text, /Subagent children/);
		assert.doesNotMatch(text, /\x1b/);
		assert.equal(type, "warning");
	}
	const status = notifier();
	await pi.commands.governor!.handler("", { ...ctx(), ui: status.ui });
	assert.match(status.notes[0]![0], /Approvals\n  mcp__t__create_issue/, "the approval is still live");
});

// ---- subagent children --------------------------------------------------------------------------

function fakeHook(opts: { throwOnRegister?: string } = {}) {
	const calls: Array<{ sessionId: string; extensions: Array<{ id: string; path: string }> }> = [];
	let disposed = 0;
	const hook: RequiredChildHook = {
		registerRequiredChildExtensions(input) {
			if (opts.throwOnRegister) throw new Error(opts.throwOnRegister);
			calls.push(input);
			return { dispose: () => void disposed++ };
		},
	};
	return { hook, calls, disposed: () => disposed };
}
const statusOf = async (pi: ReturnType<typeof fakePi>) => {
	const notes: string[] = [];
	await pi.commands.governor!.handler("", { ...ctx(), ui: { notify: (m: string) => notes.push(m) } });
	return notes[0]!;
};

test("children: session_start registers the host with pi-subagents under the session id", async () => {
	const pi = fakePi();
	const f = fakeHook();
	host(pi, async () => f.hook);
	await emit(pi, "session_start", {}, { ...ctx(), sessionManager: { getSessionId: () => "01abc", getSessionFile: () => "/sessions/x.jsonl" } });
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0]!.sessionId, "01abc", "the id pi-subagents looks up, never the session file path");
	assert.deepEqual(f.calls[0]!.extensions.map((e) => e.id), ["pi-governor"]);
	assert.match(f.calls[0]!.extensions[0]!.path, /extensions\/governor\/host\.ts$/);
	assert.match(await statusOf(pi), /registered pi-governor with pi-subagents/);
});

test("children: shutdown disposes the registration, and a new session registers again", async () => {
	const pi = fakePi();
	const f = fakeHook();
	host(pi, async () => f.hook);
	const s = { ...ctx(), sessionManager: { getSessionId: () => "01abc", getSessionFile: () => undefined } };
	await emit(pi, "session_start", {}, s);
	await emit(pi, "session_start", {}, s);
	assert.equal(f.disposed(), 1, "a second session_start drops the first registration first");
	await emit(pi, "session_shutdown", {}, s);
	assert.equal(f.disposed(), 2);
	assert.equal(f.calls.length, 2);
});

test("children: without pi-subagents the status says not known, never covered", async () => {
	const pi = fakePi();
	host(pi, async () => undefined);
	await emit(pi, "session_start", {});
	const text = await statusOf(pi);
	assert.match(text, /Subagent children: not known\. pi-subagents was not found/);
	assert.doesNotMatch(text, /registered pi-governor/);
});

test("children: a registration pi-subagents refuses is reported as NOT covered, and the session still works", async () => {
	const pi = fakePi();
	const f = fakeHook({ throwOnRegister: "Required child extensions are already registered for session '01abc'; dispose them first." });
	host(pi, async () => f.hook);
	await emit(pi, "session_start", {}, { ...ctx(), sessionManager: { getSessionId: () => "01abc", getSessionFile: () => undefined } });
	assert.match(await statusOf(pi), /Subagent children: NOT covered\. Registering pi-governor with pi-subagents failed: Required child extensions are already registered/);
	assert.equal((await emit(pi, "tool_call", call(WRITE.name)))?.block, true, "the guard still works in this session");
});

test("children: a loader that throws is reported as a failure, not as covered", async () => {
	const pi = fakePi();
	host(pi, async () => {
		throw new Error("import exploded");
	});
	await emit(pi, "session_start", {});
	assert.match(await statusOf(pi), /NOT covered.*import exploded/);
});

test("children: the host looks for pi-subagents where this process loaded it, first", async () => {
	const pkg = mkdtempSync(join(tmpdir(), "governor-subagents-"));
	try {
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pi-subagents", exports: { "./required-child-extensions": { default: "./hook.js" } } }));
		const pi = fakePi([WRITE, READ, BASH, { name: "subagent", sourceInfo: { path: join(pkg, "index.js"), source: "x", scope: "user", origin: "package", baseDir: pkg } as LiveTool["sourceInfo"] }]);
		let asked: string[] = [];
		host(pi, async (specs) => {
			asked = specs;
			return undefined;
		});
		await emit(pi, "session_start", {});
		assert.equal(asked[0], `file://${join(pkg, "hook.js")}`);
		assert.equal(asked[1], "pi-subagents/required-child-extensions");
	} finally {
		rmSync(pkg, { recursive: true, force: true });
	}
});

test("children: before session_start the status says not known yet", async () => {
	const pi = fakePi();
	host(pi);
	assert.match(await statusOf(pi), /Subagent children: not known yet/);
});
