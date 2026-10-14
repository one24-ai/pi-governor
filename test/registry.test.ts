/**
 * The registry and the client: load order, the required whenNoHost choice, the fallback when no
 * host takes the rules, and that nobody can replace another package's rules.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { type NoHostHandler, registerRules } from "../extensions/governor/client.ts";
import { API_VERSION, hostCount, isCovered, livePacks, markCovered, PENDING, publishHost, queuePending, REGISTRY } from "../extensions/governor/registry.ts";
import type { LiveTool, Rule } from "../extensions/governor/rules.ts";

const g = globalThis as unknown as Record<symbol, unknown>;
const reset = () => {
	delete g[REGISTRY];
	delete g[PENDING];
};
beforeEach(reset);
afterEach(reset);

const src = (path: string) => ({ path, source: "x", scope: "user", origin: "top-level" }) as LiveTool["sourceInfo"];
const WRITE: LiveTool = { name: "mcp__t__create_issue", namespace: { name: "mcp__t" }, sourceInfo: src("builtin:mcp") };

interface FakePi {
	handlers: Record<string, Array<(e: any, c: any) => any>>;
	on(event: string, handler: (e: any, c: any) => any): void;
	getAllTools(): LiveTool[];
}
function fakePi(tools: LiveTool[] = [WRITE]): FakePi {
	const handlers: FakePi["handlers"] = {};
	return {
		handlers,
		on(event, handler) {
			(handlers[event] ??= []).push(handler);
		},
		getAllTools: () => tools,
	};
}
const asPi = (p: FakePi) => p as unknown as Parameters<typeof registerRules>[0];
const fire = async (p: FakePi, event: string, e: any, ctx: any = { sessionManager: SESSION }) => {
	for (const h of p.handlers[event] ?? []) {
		const r = await h(e, ctx);
		if (r?.block) return r;
	}
	return undefined;
};
const SESSION = {};
const ask: Rule = { tool: { server: "t", tool: "create_issue" }, verdict: "ask" };
const call = (extra: object = {}) => ({ toolName: WRITE.name, toolCallId: "c1", input: { summary: "s" }, ...extra });

// ---- registration choice ---------------------------------------------------------------------

test("a rule pack that skips whenNoHost throws at registration", () => {
	assert.throws(() => registerRules(asPi(fakePi()), { id: "p", rules: [ask] } as any), /whenNoHost is required/);
	assert.throws(() => registerRules(asPi(fakePi()), { id: "p", rules: [ask], whenNoHost: undefined } as any), /whenNoHost is required/);
	assert.throws(() => registerRules(asPi(fakePi()), { id: "p", rules: [ask], whenNoHost: "allow" } as any), /whenNoHost is required/);
	assert.throws(() => registerRules(asPi(fakePi()), { id: "p", rules: [ask], whenNoHost: true } as any), /whenNoHost is required/);
	assert.throws(() => registerRules(asPi(fakePi()), { id: "p", rules: [ask], whenNoHost: null } as any), /whenNoHost is required/);
});

test("nothing is queued or registered when registration throws", () => {
	const pi = fakePi();
	assert.throws(() => registerRules(asPi(pi), { id: "p", rules: [ask] } as any));
	assert.deepEqual(g[PENDING] ?? [], []);
	assert.equal(pi.handlers.tool_call, undefined);
});

test("bad ids and bad rules throw", () => {
	assert.throws(() => registerRules(asPi(fakePi()), { id: "", rules: [], whenNoHost: "block" }), /id/);
	assert.throws(() => registerRules(asPi(fakePi()), { id: "p", rules: "x" as any, whenNoHost: "block" }), /rules must be an array/);
	assert.throws(() => registerRules(asPi(fakePi()), { id: "p", rules: [{ tool: "x", verdict: "maybe" } as any], whenNoHost: "block" }), /verdict/);
});

// ---- load order ------------------------------------------------------------------------------

test("package first, host later: the host takes the queue over", () => {
	const pi = fakePi();
	const handle = registerRules(asPi(pi), { id: "p", rules: [ask], whenNoHost: "block" });
	assert.equal(handle.state(), "no-host");
	assert.equal(livePacks().length, 0);
	const unpublish = publishHost("h1");
	assert.equal(handle.state(), "hosted");
	assert.deepEqual(livePacks().map((p) => p.id), ["p"]);
	unpublish();
});

test("host first, package later: registered straight away", () => {
	const unpublish = publishHost("h1");
	const handle = registerRules(asPi(fakePi()), { id: "p", rules: [ask], whenNoHost: "block" });
	assert.equal(handle.state(), "hosted");
	assert.deepEqual(livePacks().map((p) => p.id), ["p"]);
	unpublish();
});

test("the last host going away puts whenNoHost back in force, and a later host takes the rules again", () => {
	const unpublish = publishHost("h1");
	const handle = registerRules(asPi(fakePi()), { id: "p", rules: [ask], whenNoHost: "block" });
	unpublish();
	assert.equal(handle.state(), "no-host");
	assert.equal(livePacks().length, 0);
	const again = publishHost("h2");
	assert.equal(handle.state(), "hosted");
	again();
});

test("two hosts share one store; it ends with the last one", () => {
	const a = publishHost("h1");
	const handle = registerRules(asPi(fakePi()), { id: "p", rules: [ask], whenNoHost: "block" });
	const b = publishHost("h2");
	assert.equal(hostCount(), 2);
	a();
	assert.equal(handle.state(), "hosted", "still one host");
	assert.equal(livePacks().length, 1);
	b();
	assert.equal(handle.state(), "no-host");
});

test("the same host id twice counts once", () => {
	const a = publishHost("h1");
	const b = publishHost("h1");
	assert.equal(hostCount(), 1);
	a();
	b();
});

test("a different API version: the host refuses to start, the client stays on whenNoHost", () => {
	(g[REGISTRY] as any) = { apiVersion: API_VERSION + 1, register() {} };
	assert.throws(() => publishHost("h1"), /API version/);
	const handle = registerRules(asPi(fakePi()), { id: "p", rules: [ask], whenNoHost: "block" });
	assert.equal(handle.state(), "no-host");
	assert.equal(livePacks().length, 0);
});

test("a queued entry for another API version is left for a host that speaks it", () => {
	const foreign = { apiVersion: API_VERSION + 1, pack: { id: "f", rules: [] }, owner: {}, accepted() {}, revoked() {} };
	queuePending(foreign as any);
	const unpublish = publishHost("h1");
	assert.deepEqual(g[PENDING], [foreign]);
	unpublish();
});

// ---- whenNoHost behaviour --------------------------------------------------------------------

test('whenNoHost "block": calls the rules cover are blocked; others pass', async () => {
	const pi = fakePi([WRITE, { name: "other", sourceInfo: src("/x.ts") }]);
	registerRules(asPi(pi), { id: "p", rules: [ask], whenNoHost: "block" });
	const r = await fire(pi, "tool_call", call());
	assert.equal(r?.block, true);
	assert.match(r.reason, /pi-governor is not loaded/);
	assert.match(r.reason, /Do not retry/);
	assert.equal(await fire(pi, "tool_call", { toolName: "other", toolCallId: "c2", input: {} }), undefined);
});

test("whenNoHost handler: it decides for the calls the rules cover", async () => {
	const seen: string[] = [];
	const handler: NoHostHandler = (c, _ctx, rules) => {
		seen.push(`${c.toolName}:${rules.length}`);
		return { block: true, reason: "own dialog said no" };
	};
	const pi = fakePi();
	registerRules(asPi(pi), { id: "p", rules: [ask], whenNoHost: handler });
	const r = await fire(pi, "tool_call", call());
	assert.equal(r?.reason, "own dialog said no");
	assert.deepEqual(seen, ["mcp__t__create_issue:1"]);
});

test("whenNoHost handler that allows lets the call run; one that throws blocks", async () => {
	const pi = fakePi();
	registerRules(asPi(pi), { id: "ok", rules: [ask], whenNoHost: () => undefined });
	assert.equal(await fire(pi, "tool_call", call()), undefined);
	const pi2 = fakePi();
	registerRules(asPi(pi2), {
		id: "bad",
		rules: [ask],
		whenNoHost: () => {
			throw new Error("handler crashed");
		},
	});
	const r = await fire(pi2, "tool_call", call());
	assert.equal(r?.block, true);
	assert.match(r.reason, /handler crashed/);
});

test("a whenNoHost handler may only return nothing, null, { block: false } or { block: true }; anything else blocks", async () => {
	const bad: unknown[] = [false, 0, "", "no", {}, { blocked: true }, { block: "true" }, { block: 1 }, [], true, 42];
	for (const value of bad) {
		const pi = fakePi();
		registerRules(asPi(pi), { id: "p", rules: [ask], whenNoHost: () => value as any });
		const r = await fire(pi, "tool_call", call());
		assert.equal(r?.block, true, `returned ${JSON.stringify(value)}`);
	}
	for (const value of [undefined, null, { block: false }]) {
		const pi = fakePi();
		registerRules(asPi(pi), { id: "p", rules: [ask], whenNoHost: () => value as any });
		assert.equal(await fire(pi, "tool_call", call()), undefined, `returned ${JSON.stringify(value)}`);
	}
	const pi = fakePi();
	registerRules(asPi(pi), { id: "p", rules: [ask], whenNoHost: async () => ({ block: true, reason: "mine" }) });
	assert.equal((await fire(pi, "tool_call", call()))?.reason, "mine");
	const pi2 = fakePi();
	registerRules(asPi(pi2), { id: "p", rules: [ask], whenNoHost: async () => ({ block: true }) });
	assert.match((await fire(pi2, "tool_call", call()))?.reason, /fallback blocked/);
});

test("a registration the live store refused is kept for a later host", () => {
	g[REGISTRY] = {
		apiVersion: API_VERSION,
		register() {
			throw new Error("store is full");
		},
	};
	const handle = registerRules(asPi(fakePi()), { id: "p", rules: [ask], whenNoHost: "block" });
	assert.equal(handle.state(), "no-host");
	assert.equal(handle.error(), "store is full");
	assert.equal((g[PENDING] as unknown[]).length, 1);
});

test("the fallback only covers ask and never rules, and respects argument narrowing", async () => {
	const pi = fakePi();
	const rules: Rule[] = [
		{ tool: { server: "t", tool: "create_issue" }, verdict: "allow" },
		{ tool: { server: "t", tool: "create_issue" }, args: { summary: "danger" }, verdict: "never" },
	];
	registerRules(asPi(pi), { id: "p", rules, whenNoHost: "block" });
	assert.equal(await fire(pi, "tool_call", call({ input: { summary: "fine" } })), undefined, "allow rules are not enforced");
	assert.equal((await fire(pi, "tool_call", call({ input: { summary: "danger" } })))?.block, true);
});

test("a host in the process but not in this session does not cover it", async () => {
	const unpublish = publishHost("h1");
	const pi = fakePi();
	const handle = registerRules(asPi(pi), { id: "p", rules: [ask], whenNoHost: "block" });
	assert.equal(handle.state(), "hosted");
	const uncovered = {};
	assert.equal((await fire(pi, "tool_call", call(), { sessionManager: uncovered }))?.block, true, "no host handler in this session: whenNoHost applies");
	markCovered(SESSION);
	assert.equal(isCovered(SESSION), true);
	assert.equal(await fire(pi, "tool_call", call(), { sessionManager: SESSION }), undefined, "a host handler is here: the host decides");
	unpublish();
	assert.equal(isCovered(SESSION), false);
});

test("a rule that cannot match a live tool name: the fallback matches by registered name only", async () => {
	const pi = fakePi([]);
	registerRules(asPi(pi), { id: "p", rules: [ask], whenNoHost: "block" });
	assert.equal((await fire(pi, "tool_call", call()))?.block, true, "the plain name still matches when the tool is not listed (an ask rule applies)");
});

// ---- ownership -------------------------------------------------------------------------------

test("registering the same id again from the same package replaces its rules", () => {
	const unpublish = publishHost("h1");
	const pi = fakePi();
	registerRules(asPi(pi), { id: "p", rules: [ask], whenNoHost: "block" });
	registerRules(asPi(pi), { id: "p", rules: [], whenNoHost: "block" });
	assert.equal(livePacks().length, 1);
	assert.equal(livePacks()[0]!.rules.length, 0);
	unpublish();
});

test("another package using the same id cannot replace, and so loosen, the first one's rules", () => {
	const unpublish = publishHost("h1");
	registerRules(asPi(fakePi()), { id: "p", rules: [{ tool: "x", verdict: "never" }], whenNoHost: "block" });
	registerRules(asPi(fakePi()), { id: "p", rules: [], whenNoHost: "block" });
	assert.equal(livePacks().length, 2);
	assert.equal(livePacks().filter((p) => p.rules.length === 1).length, 1);
	unpublish();
});

test("rules are copied and frozen: later edits to the original do not reach the host", () => {
	const unpublish = publishHost("h1");
	const rule: Rule = { tool: "x", verdict: "never" };
	const rules = [rule];
	registerRules(asPi(fakePi()), { id: "p", rules, whenNoHost: "block" });
	rule.verdict = "allow";
	rules.length = 0;
	const held = livePacks()[0]!.rules;
	assert.equal(held.length, 1);
	assert.equal(held[0]!.verdict, "never");
	assert.throws(() => {
		(held[0] as any).verdict = "allow";
	}, TypeError);
	unpublish();
});

test("a rule with a getter cannot pass validation and then change", () => {
	const unpublish = publishHost("h1");
	let calls = 0;
	const sneaky = {
		tool: "x",
		get verdict() {
			return calls++ === 0 ? "never" : "allow";
		},
	} as unknown as Rule;
	registerRules(asPi(fakePi()), { id: "p", rules: [sneaky], whenNoHost: "block" });
	assert.equal(livePacks()[0]!.rules[0]!.verdict, "never");
	assert.equal(livePacks()[0]!.rules[0]!.verdict, "never");
	unpublish();
});

// ---- dispose ---------------------------------------------------------------------------------

test("dispose removes the rules from the host and from the queue; session_shutdown does it too", async () => {
	const unpublish = publishHost("h1");
	const pi = fakePi();
	const handle = registerRules(asPi(pi), { id: "p", rules: [ask], whenNoHost: "block" });
	assert.equal(livePacks().length, 1);
	await fire(pi, "session_shutdown", {});
	assert.equal(livePacks().length, 0);
	assert.equal(handle.state(), "no-host");
	assert.equal(await fire(pi, "tool_call", call()), undefined, "a disposed registration enforces nothing");
	unpublish();

	const pi2 = fakePi();
	const queued = registerRules(asPi(pi2), { id: "q", rules: [ask], whenNoHost: "block" });
	queued.dispose();
	assert.deepEqual(g[PENDING], []);
});
