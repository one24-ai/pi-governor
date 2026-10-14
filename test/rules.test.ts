/**
 * Classification, config, rule matching and decide(). See docs/design.md, "Tests that matter".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMcpToolNames } from "../extensions/governor/names.ts";
import {
	BUILTIN_TOOLS,
	classify,
	decide,
	type LiveTool,
	matchPattern,
	parseConfig,
	resolveDefaults,
	type Rule,
	ruleNamesTool,
	SHIPPED_DEFAULTS,
	validateRule,
} from "../extensions/governor/rules.ts";

const src = (path: string) => ({ path, source: "x", scope: "user", origin: "top-level" }) as LiveTool["sourceInfo"];
const builtin = (name: string): LiveTool => ({ name, sourceInfo: src(`builtin:${name}`) });
const ext = (name: string): LiveTool => ({ name, sourceInfo: src("/ext/index.ts") });
const mcp = (name: string, server: string, annotations?: LiveTool["annotations"]): LiveTool => ({
	name,
	namespace: { name: `mcp__${server.replace(/-/g, "_")}` },
	sourceInfo: src("builtin:mcp"),
	...(annotations ? { annotations } : {}),
});
const call = (name: string, input: unknown = {}) => ({ name, input });
const D = { ...SHIPPED_DEFAULTS };

// ---- classification --------------------------------------------------------------------------

test("classify: built-in, override, extension, MCP, adapter MCP, unknown", () => {
	assert.equal(classify("read", builtin("read")), "builtin");
	assert.equal(classify("bash", ext("bash")), "extension", "an extension's own bash is not a built-in");
	assert.equal(classify("codemode", { name: "codemode", sourceInfo: src("builtin:codemode") }), "extension");
	assert.equal(classify("mcp__srv__x", mcp("mcp__srv__x", "srv")), "mcp");
	assert.equal(classify("mcp__srv__x", ext("mcp__srv__x")), "mcp", "an adapter's mcp__ tool counts as mcp");
	assert.equal(classify("other", { name: "other", namespace: { name: "mcp__srv" }, sourceInfo: src("/a.ts") }), "mcp");
	assert.equal(classify("ghost", undefined), "unknown");
});

test("BUILTIN_TOOLS matches pi's own list", async () => {
	// @ts-ignore no declarations for this deep path
	const { allToolNames } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js");
	assert.deepEqual([...BUILTIN_TOOLS].sort(), [...(allToolNames as Set<string>)].sort());
});

// ---- source defaults -------------------------------------------------------------------------

test("shipped defaults: MCP follows readOnlyHint, built-ins and extensions pass", () => {
	assert.equal(decide(call("mcp__s__r"), mcp("mcp__s__r", "s", { readOnlyHint: true }), [], D).verdict, "allow");
	assert.equal(decide(call("mcp__s__w"), mcp("mcp__s__w", "s", { readOnlyHint: false }), [], D).verdict, "ask");
	assert.equal(decide(call("mcp__s__u"), mcp("mcp__s__u", "s"), [], D).verdict, "ask", "no annotations asks");
	assert.equal(decide(call("read"), builtin("read"), [], D).verdict, "allow");
	assert.equal(decide(call("my_tool"), ext("my_tool"), [], D).verdict, "allow");
});

test("an unknown tool asks, an allow rule cannot pass it, a never rule blocks it", () => {
	assert.equal(decide(call("ghost"), undefined, [], D).verdict, "ask");
	assert.equal(decide(call("ghost"), undefined, [{ tool: "ghost", verdict: "allow" }], D).verdict, "ask");
	assert.equal(decide(call("ghost"), undefined, [{ tool: "ghost", verdict: "never" }], D).verdict, "never");
});

test("each source default takes effect", () => {
	const strict = { mcp: "never", builtin: "ask", extension: "hints" } as const;
	assert.equal(decide(call("mcp__s__r"), mcp("mcp__s__r", "s", { readOnlyHint: true }), [], strict).verdict, "never");
	assert.equal(decide(call("read"), builtin("read"), [], strict).verdict, "ask");
	assert.equal(decide(call("t"), ext("t"), [], strict).verdict, "ask");
	assert.equal(decide(call("t"), { ...ext("t"), annotations: { readOnlyHint: true } }, [], strict).verdict, "allow");
});

test("an unannotated server's read tools pass only when a rule says so", () => {
	const tool = mcp("mcp__deploy__get_status", "deploy");
	assert.equal(decide(call(tool.name), tool, [], D).verdict, "ask");
	assert.equal(decide(call(tool.name), tool, [{ tool: { server: "deploy", tool: "get_status" }, verdict: "allow" }], D).verdict, "allow");
});

// ---- rules win -------------------------------------------------------------------------------

test("never and ask rules beat a readOnlyHint and a source default; the strictest rule wins", () => {
	const tool = mcp("mcp__s__r", "s", { readOnlyHint: true });
	assert.equal(decide(call(tool.name), tool, [{ tool: tool.name, verdict: "ask" }], D).verdict, "ask");
	assert.equal(decide(call("read"), builtin("read"), [{ tool: "read", verdict: "never" }], D).verdict, "never");
	const rules: Rule[] = [
		{ tool: "mcp__s__*", verdict: "allow" },
		{ tool: tool.name, verdict: "ask" },
		{ tool: "*", verdict: "never" },
	];
	assert.equal(decide(call(tool.name), tool, rules, D).verdict, "never");
});

test("args narrow a rule by top-level field equality", () => {
	const tool = mcp("mcp__t__transition", "t");
	const rules: Rule[] = [{ tool: tool.name, args: { status: "Done" }, verdict: "never" }];
	assert.equal(decide(call(tool.name, { status: "Done" }), tool, rules, D).verdict, "never");
	assert.equal(decide(call(tool.name, { status: "Open" }), tool, rules, D).verdict, "ask");
	assert.equal(decide(call(tool.name, "Done"), tool, rules, D).verdict, "never", "non-object input still meets a never rule");
	assert.equal(decide(call("bash", null), builtin("bash"), [{ tool: "bash", args: { command: "rm" }, verdict: "never" }], D).verdict, "never");
	const allowRead = [{ tool: "mcp__u__get", args: { id: "1" }, verdict: "allow" }] as Rule[];
	assert.equal(decide(call("mcp__u__get", ["1"]), mcp("mcp__u__get", "u"), allowRead, D).verdict, "ask", "non-object input never meets an allow rule");
	assert.equal(decide(call(tool.name, Object.create({ status: "Done" })), tool, [{ tool: tool.name, args: { status: "Done" }, verdict: "allow" }], D).verdict, "ask", "inherited keys do not count");
	assert.equal(decide(call(tool.name, { status: 1 }), tool, [{ tool: tool.name, args: { status: "1" }, verdict: "never" }], D).verdict, "ask");
});

// ---- name matching ---------------------------------------------------------------------------

test("patterns are exact and case-sensitive, * is the only wildcard", () => {
	assert.ok(matchPattern("mcp__s__write", "mcp__s__write"));
	assert.ok(!matchPattern("mcp__s__write", "mcp__S__write"));
	assert.ok(!matchPattern("mcp__s__write", "mcp__s__write_x"));
	assert.ok(matchPattern("mcp__s__*", "mcp__s__write"));
	assert.ok(!matchPattern("mcp__s.*", "mcp__s__write"), ". is literal");
	assert.ok(!matchPattern("mcp__s__?rite", "mcp__s__write"), "? is literal");
	assert.ok(matchPattern("*write*", "mcp__s__overwrite_all"));
});

test("a write cannot get past by differing in case", () => {
	const tool = mcp("mcp__s__Write", "s");
	assert.equal(decide(call("mcp__s__Write"), tool, [{ tool: "mcp__s__write", verdict: "allow" }], D).verdict, "ask");
});

test("a pattern written without a suffix also matches the suffixed name, for ask and never only", () => {
	const name = computeMcpToolNames("srv-a", "a-b").suffixed;
	assert.ok(ruleNamesTool({ tool: "mcp__srv_a__a_b", verdict: "never" }, name, mcp(name, "srv-a")));
	assert.ok(ruleNamesTool({ tool: "mcp__srv_a__*_b", verdict: "ask" }, name, mcp(name, "srv-a")));
	// A real tool named read_12345678 must not be allowed by a rule for read.
	assert.ok(!ruleNamesTool({ tool: "mcp__s__read", verdict: "allow" }, "mcp__s__read_12345678", mcp("mcp__s__read_12345678", "s")));
});

test("server and tool by original names: plain, long and same-server collisions", () => {
	const rule = (tool: string): Rule => ({ tool: { server: "srv-a", tool }, verdict: "never" });
	assert.ok(ruleNamesTool(rule("write_thing"), "mcp__srv_a__write_thing", mcp("mcp__srv_a__write_thing", "srv-a")));
	const long = computeMcpToolNames("srv-a", "x".repeat(70)).suffixed;
	assert.ok(ruleNamesTool(rule("x".repeat(70)), long, mcp(long, "srv-a")));
	// a-b and a_b on one server: both are suffixed, and each rule names only its own tool.
	const ab = computeMcpToolNames("srv-a", "a-b").suffixed;
	const a_b = computeMcpToolNames("srv-a", "a_b").suffixed;
	assert.ok(ruleNamesTool(rule("a-b"), ab, mcp(ab, "srv-a")));
	assert.ok(!ruleNamesTool(rule("a-b"), a_b, mcp(a_b, "srv-a")));
	assert.ok(ruleNamesTool(rule("a_b"), a_b, mcp(a_b, "srv-a")));
});

test("cross-server collision: a rule never matches the other server's tool, whichever kept the plain name", () => {
	const plain = "mcp__srv_a__p__q";
	const forA: Rule = { tool: { server: "srv-a", tool: "p__q" }, verdict: "allow" };
	const forP: Rule = { tool: { server: "srv_a__p", tool: "q" }, verdict: "allow" };
	// As measured: srv_a__p kept the plain name, srv-a got the suffix.
	const pTool = mcp(plain, "srv_a__p");
	const aName = computeMcpToolNames("srv-a", "p__q").suffixed;
	const aTool = mcp(aName, "srv-a");
	assert.ok(ruleNamesTool(forP, plain, pTool));
	assert.ok(!ruleNamesTool(forA, plain, pTool));
	assert.ok(ruleNamesTool(forA, aName, aTool));
	assert.ok(!ruleNamesTool(forP, aName, aTool));
	// The other order.
	const aPlain = mcp(plain, "srv-a");
	const pName = computeMcpToolNames("srv_a__p", "q").suffixed;
	assert.ok(ruleNamesTool(forA, plain, aPlain));
	assert.ok(!ruleNamesTool(forP, plain, aPlain));
	assert.ok(ruleNamesTool(forP, pName, mcp(pName, "srv_a__p")));
});

test("plain name with an unknown owner: ask and never rules apply, allow rules do not", () => {
	const name = "mcp__srv_a__p__q";
	const owned = { name, sourceInfo: src("/adapter.ts") } as LiveTool;
	assert.ok(!ruleNamesTool({ tool: { server: "srv-a", tool: "p__q" }, verdict: "allow" }, name, owned));
	assert.ok(ruleNamesTool({ tool: { server: "srv-a", tool: "p__q" }, verdict: "ask" }, name, owned));
	assert.ok(ruleNamesTool({ tool: { server: "srv-a", tool: "p__q" }, verdict: "never" }, name, owned));
});

// ---- validation ------------------------------------------------------------------------------

test("validateRule rejects rules the layer cannot apply safely", () => {
	assert.doesNotThrow(() => validateRule({ tool: "x", verdict: "ask", preview: () => "", windowMs: 1000, trustedParents: ["t"] }));
	assert.throws(() => validateRule({ tool: "x", verdict: "maybe" as any }));
	assert.throws(() => validateRule({ tool: "", verdict: "allow" }));
	assert.throws(() => validateRule({ tool: { server: "s", tool: "" }, verdict: "allow" }));
	assert.throws(() => validateRule({ tool: "x", verdict: "allow", windowMs: 1000 }));
	assert.throws(() => validateRule({ tool: "x", verdict: "ask", windowMs: 0 }));
	assert.throws(() => validateRule({ tool: "x", verdict: "ask", preview: "text" as any }));
	assert.throws(() => validateRule({ tool: "x", verdict: "never", args: { a: { b: 1 } as any } }));
	for (const bad of ["constructor", "toString", "__proto__", "hasOwnProperty", ["ask"]]) {
		assert.throws(() => validateRule({ tool: "x", verdict: bad as any }), `verdict ${JSON.stringify(bad)}`);
	}
});

test("decide never returns a verdict outside allow, ask and never", () => {
	const bogus = { mcp: "constructor", builtin: "toString", extension: undefined } as any;
	assert.equal(decide(call("mcp__s__x"), mcp("mcp__s__x", "s"), [], bogus).verdict, "ask");
	assert.equal(decide(call("read"), builtin("read"), [], bogus).verdict, "ask");
	assert.equal(decide(call("t"), ext("t"), [], bogus).verdict, "ask");
});

// ---- config ----------------------------------------------------------------------------------

test("parseConfig accepts only known keys and values", () => {
	assert.deepEqual(parseConfig(`{"defaults":{"builtin":"ask"}}`), { ok: true, defaults: { builtin: "ask" } });
	assert.deepEqual(parseConfig(`{}`), { ok: true, defaults: {} });
	assert.equal(parseConfig(`{"defaults":{"buitlin":"ask"}}`).ok, false);
	assert.equal(parseConfig(`{"defaults":{"mcp":"Allow"}}`).ok, false);
	assert.equal(parseConfig(`{"default":{}}`).ok, false);
	assert.equal(parseConfig(`{"defaults":{"unknown":"ask"}}`).ok, false, "unknown is not configurable");
	assert.equal(parseConfig(`not json`).ok, false);
	assert.equal(parseConfig(`[]`).ok, false);
	for (const bad of ["constructor", "toString", "__proto__", "valueOf"]) {
		assert.equal(parseConfig(`{"defaults":{"mcp":"${bad}"}}`).ok, false, bad);
	}
	assert.equal(parseConfig(`{"defaults":{"mcp":["ask"]}}`).ok, false);
	assert.equal(parseConfig(`{"defaults":{"__proto__":"allow"}}`).ok, false);
});

test("resolveDefaults: global sets, project only tightens, a broken file falls back to asking", () => {
	assert.deepEqual(resolveDefaults(), SHIPPED_DEFAULTS);
	const g = parseConfig(`{"defaults":{"mcp":"allow","builtin":"ask"}}`);
	assert.deepEqual(resolveDefaults(g), { mcp: "allow", builtin: "ask", extension: "allow" });
	const loosen = parseConfig(`{"defaults":{"mcp":"allow","builtin":"allow"}}`);
	assert.deepEqual(resolveDefaults(undefined, loosen), SHIPPED_DEFAULTS, "project cannot loosen");
	const tighten = parseConfig(`{"defaults":{"extension":"never"}}`);
	assert.deepEqual(resolveDefaults(g, tighten), { mcp: "allow", builtin: "ask", extension: "never" });
	assert.deepEqual(resolveDefaults(parseConfig("{"), undefined), { mcp: "ask", builtin: "ask", extension: "ask" });
	assert.deepEqual(resolveDefaults(g, parseConfig("{")), { mcp: "ask", builtin: "ask", extension: "ask" });
	assert.deepEqual(resolveDefaults(parseConfig(`{"defaults":{"mcp":"never"}}`), parseConfig("{")).mcp, "never");
});
