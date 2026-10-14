/**
 * The MCP name computation matches the installed pi's own function, for the cases measured live
 * on pi 1.1.0 (see docs/design.md, Findings).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
// pi's implementation, not a public export: imported by path so the test fails if it moves.
// @ts-ignore no declarations for this deep path
import { createMcpToolName } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js";
import { computeMcpToolNames, stripHashSuffix, suffixedMcpToolName } from "../extensions/governor/names.ts";

const cases: Array<[string, string]> = [
	["srv-a", "read_thing"],
	["srv-a", "a-b"],
	["srv-a", "a_b"],
	["srv-a", "p__q"],
	["srv_a__p", "q"],
	["srv-a", "x".repeat(70)],
	["s", "x".repeat(55)],
	["s", "x".repeat(56)],
	["my.server", "do/thing"],
	["srv", "émoji✓"],
];

test("plain names match pi when nothing is taken", () => {
	for (const [server, tool] of cases) {
		const ours = computeMcpToolNames(server, tool);
		assert.equal(ours.plain ?? ours.suffixed, createMcpToolName(server, tool), `${server}/${tool}`);
	}
});

test("suffixed names match pi when the plain name is taken", () => {
	for (const [server, tool] of cases) {
		assert.equal(computeMcpToolNames(server, tool).suffixed, createMcpToolName(server, tool, () => true), `${server}/${tool}`);
	}
});

test("names measured on pi 1.1.0", () => {
	assert.equal(suffixedMcpToolName("srv-a", "a-b"), "mcp__srv_a__a_b_5cedebc2");
	assert.equal(suffixedMcpToolName("srv-a", "a_b"), "mcp__srv_a__a_b_795d8c8f");
	assert.equal(suffixedMcpToolName("srv-a", "p__q"), "mcp__srv_a__p__q_13e746a6");
	const long = computeMcpToolNames("srv-a", "x".repeat(70));
	assert.equal(long.plain, undefined);
	assert.equal(long.suffixed.length, 64);
	assert.ok(long.suffixed.endsWith("_7f18c2c9"));
});

test("the 64-character boundary", () => {
	// "mcp__s__" is 8 characters.
	assert.equal(computeMcpToolNames("s", "x".repeat(56)).plain?.length, 64);
	assert.equal(computeMcpToolNames("s", "x".repeat(57)).plain, undefined);
});

test("a cross-server collision yields the same plain name for both tools", () => {
	assert.equal(computeMcpToolNames("srv-a", "p__q").plain, computeMcpToolNames("srv_a__p", "q").plain);
	assert.notEqual(computeMcpToolNames("srv-a", "p__q").suffixed, computeMcpToolNames("srv_a__p", "q").suffixed);
});

test("stripHashSuffix removes only an 8-hex suffix", () => {
	assert.equal(stripHashSuffix("mcp__srv_a__a_b_5cedebc2"), "mcp__srv_a__a_b");
	assert.equal(stripHashSuffix("mcp__srv_a__a_b"), "mcp__srv_a__a_b");
	assert.equal(stripHashSuffix("mcp__srv__x_ABCDEF12"), "mcp__srv__x_ABCDEF12");
	assert.equal(stripHashSuffix("mcp__srv__x_5cedebc"), "mcp__srv__x_5cedebc");
});
