/**
 * /governor says plainly what is covered, and says "not known" for what it cannot see.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostPack } from "../extensions/governor/registry.ts";
import { type LiveTool, parseConfig, type Rule, SHIPPED_DEFAULTS } from "../extensions/governor/rules.ts";
import { buildStatus, type StatusInput } from "../extensions/governor/status.ts";

const src = (path: string) => ({ path, source: "x", scope: "user", origin: "top-level" }) as LiveTool["sourceInfo"];
const WRITE: LiveTool = { name: "mcp__t__create_issue", namespace: { name: "mcp__t" }, sourceInfo: src("builtin:mcp") };
const pack = (id: string, ...rules: Rule[]): HostPack => ({ id, rules });

const base = (over: Partial<StatusInput> = {}): StatusInput => ({
	hostCount: 1,
	covered: true,
	pending: 0,
	packs: [],
	tools: [],
	config: undefined,
	defaults: { ...SHIPPED_DEFAULTS },
	approvals: [],
	now: 1_000_000,
	...over,
});

test("the status never claims subagent children or handler order are covered", () => {
	const text = buildStatus(base());
	assert.match(text, /Subagent children: not known/);
	assert.match(text, /Treat children as not covered/);
	assert.match(text, /Handler order: measured on pi 1\.2\.0/);
	assert.match(text, /loaded AFTER this one can change a call's arguments/);
	assert.match(text, /Not gated: pi's own process/);
});

test("a session without a governor handler is called out", () => {
	assert.match(buildStatus(base({ covered: false })), /NO governor handler of its own/);
	assert.match(buildStatus(base({ covered: true })), /calls are checked/);
});

test("source defaults and the config files are listed, and a broken file is named as broken", () => {
	const ok = parseConfig('{"defaults":{"builtin":"ask"}}');
	const bad = parseConfig("{ nope");
	const text = buildStatus(
		base({
			config: { global: { path: "/home/u/.pi/agent/governor.json", parsed: ok }, project: { path: "/p/.pi/governor.json", parsed: bad } },
			defaults: { mcp: "ask", builtin: "ask", extension: "ask" },
		}),
	);
	assert.match(text, /mcp: ask/);
	assert.match(text, /global file: .*governor\.json \(builtin=ask\)/);
	assert.match(text, /project file: .* IS BROKEN \(not valid JSON/);
	assert.match(text, /every source asks until it is fixed/);
	assert.match(buildStatus(base({ config: { global: { path: "g", parsed: undefined }, project: { path: "p", parsed: undefined } } })), /\(not present\)/);
	assert.match(buildStatus(base()), /not been read yet/);
});

test("packs and rules are listed with their narrowing, window and trusted parents", () => {
	const rule: Rule = { tool: { server: "t", tool: "create_issue" }, args: { status: "Done" }, verdict: "ask", windowMs: 15 * 60_000, trustedParents: ["confirmed"] };
	const text = buildStatus(base({ packs: [pack("tracker", rule, { tool: "mcp__t__*", verdict: "never" })], tools: [WRITE] }));
	assert.match(text, /tracker: 2 rules/);
	assert.match(text, /ask +t \/ create_issue, when status match, window 15 minutes, trusts confirmed/);
	assert.match(text, /never mcp__t__\*/);
});

test("a rule that matches no live tool is reported, with the right explanation", () => {
	const dead: Rule = { tool: { server: "typo", tool: "create_issue" }, verdict: "never" };
	const live: Rule = { tool: { server: "t", tool: "create_issue" }, verdict: "never" };
	const withMcp = buildStatus(base({ packs: [pack("p", dead, live)], tools: [WRITE] }));
	assert.match(withMcp, /Rules that match no live tool\n {2}p: never +typo \/ create_issue/);
	assert.ok(!/p: never +t \/ create_issue/.test(withMcp.split("Rules that match no live tool")[1]!.split("Approvals")[0]!), "the matching rule is not listed");
	assert.match(withMcp, /protects nothing yet/);
	const noMcp = buildStatus(base({ packs: [pack("p", dead)], tools: [] }));
	assert.match(noMcp, /No MCP tools are listed yet/);
	assert.match(buildStatus(base({ packs: [pack("p", live)], tools: [WRITE] })), /Rules that match no live tool\n {2}None\./);
});

test("live approvals show the time left", () => {
	const text = buildStatus(base({ approvals: [{ tool: "mcp__t__create_issue", expiresAt: 1_000_000 + 5 * 60_000 }] }));
	assert.match(text, /mcp__t__create_issue: 5 minutes left/);
	assert.match(buildStatus(base()), /None live/);
});

test("pending registrations and several hosts are reported", () => {
	const text = buildStatus(base({ hostCount: 2, pending: 3 }));
	assert.match(text, /2 hosts loaded/);
	assert.match(text, /3 registrations are waiting for a host they can use/);
});

test("pack ids and tool names from outside are made visible", () => {
	const evil = `bad\x1b[2J`;
	const text = buildStatus(base({ packs: [pack(evil, { tool: evil, verdict: "never" })], approvals: [{ tool: evil, expiresAt: 2_000_000 }] }));
	assert.ok(!text.includes("\x1b"));
});

test("a long rule list is cut and says how many are left", () => {
	const rules: Rule[] = Array.from({ length: 30 }, (_, i) => ({ tool: `tool_${i}`, verdict: "never" }) as Rule);
	assert.match(buildStatus(base({ packs: [pack("big", ...rules)] })), /\.\.\. and 18 more/);
});
