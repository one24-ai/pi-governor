/**
 * The host extension: what pi loads. Wiring only; decisions are tested in guard.test.ts.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { registerRules } from "../extensions/governor/client.ts";
import governorHost from "../extensions/governor/host.ts";
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
const call = (toolName: string, extra: object = {}) => ({ toolName, toolCallId: "c1", input: {}, ...extra });

test("package.json loads the host, and the host's default export is a function", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.deepEqual(pkg.pi.extensions, ["./extensions/governor/host.ts"]);
	assert.equal(typeof governorHost, "function");
});

test("loading publishes the store and installs the handlers", () => {
	const pi = fakePi();
	governorHost(asPi(pi));
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
	governorHost(asPi(pi));
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
	governorHost(asPi(pi));
	(pi as any).getAllTools = () => {
		throw new Error("tool list unavailable");
	};
	const notes: string[] = [];
	await pi.commands.governor!.handler("", { ...ctx(), ui: { notify: (m: string) => notes.push(m) } });
	assert.match(notes[0]!, /could not build its status: tool list unavailable/);
});

test("session_start marks the session covered; shutdown ends the store", async () => {
	const pi = fakePi();
	governorHost(asPi(pi));
	assert.equal(isCovered(session), false);
	await emit(pi, "session_start", {});
	assert.equal(isCovered(session), true);
	await emit(pi, "session_shutdown", {});
	assert.equal(hostCount(), 0);
});

test("a registered package's rules are applied to real calls", async () => {
	const pi = fakePi();
	registerRules(asPi(pi) as any, { id: "p", rules: [{ tool: { server: "t", tool: "get_issue" }, verdict: "never" }], whenNoHost: "block" });
	governorHost(asPi(pi));
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
	governorHost(asPi(pi));
	await emit(pi, "session_start", {});
	const r = await emit(pi, "tool_call", call(WRITE.name), ctx(true, true));
	assert.equal(r, undefined, "the host asked and the user approved; the fallback did not run");
});

test("tool_execution_start and end drive trustedParents, and parentToolCallId is forwarded", async () => {
	const pi = fakePi();
	registerRules(asPi(pi) as any, { id: "p", rules: [{ tool: { server: "t", tool: "create_issue" }, verdict: "ask", trustedParents: ["confirmed"] }], whenNoHost: "block" });
	governorHost(asPi(pi));
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
	governorHost(asPi(pi));
	await emit(pi, "session_start", {});
	assert.equal((await emit(pi, "tool_call", call("bash")))?.block, true, "builtin: ask, no UI");
	assert.equal((await emit(pi, "tool_call", call("mine")))?.block, true, "extension: never from the project file");
	assert.equal((await emit(pi, "tool_call", call(WRITE.name)))?.block, true, "mcp: allow tightened to hints, and the tool has no read hint");
});

test("a broken governor.json makes every source ask", async () => {
	writeFileSync(join(agentDir, "governor.json"), "{ not json");
	const pi = fakePi();
	governorHost(asPi(pi));
	await emit(pi, "session_start", {});
	assert.equal((await emit(pi, "tool_call", call("bash")))?.block, true);
	assert.equal((await emit(pi, "tool_call", call(READ.name)))?.block, true);
});

test("a governor.json that cannot be read as a file makes every source ask", async () => {
	mkdirSync(join(agentDir, "governor.json"));
	const pi = fakePi();
	governorHost(asPi(pi));
	await emit(pi, "session_start", {});
	assert.equal((await emit(pi, "tool_call", call("bash")))?.block, true, "a directory in place of the file is not 'missing'");
});

test("no governor.json at all leaves the shipped defaults", async () => {
	const pi = fakePi();
	governorHost(asPi(pi));
	await emit(pi, "session_start", {});
	assert.equal(await emit(pi, "tool_call", call("bash")), undefined);
	assert.equal(await emit(pi, "tool_call", call(READ.name)), undefined);
	assert.equal((await emit(pi, "tool_call", call(WRITE.name)))?.block, true);
});

test("a tool_call before session_start uses the shipped defaults, and still blocks an unannotated write", async () => {
	const pi = fakePi();
	governorHost(asPi(pi));
	assert.equal((await emit(pi, "tool_call", call(WRITE.name)))?.block, true);
});
