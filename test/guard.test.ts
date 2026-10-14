/**
 * Guard: every verdict, every fail-closed path, nested calls and approval windows.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Guard, type GuardContext, type GuardEvent } from "../extensions/governor/guard.ts";
import type { HostPack } from "../extensions/governor/registry.ts";
import { type LiveTool, type Rule, SHIPPED_DEFAULTS } from "../extensions/governor/rules.ts";

const src = (path: string) => ({ path, source: "x", scope: "user", origin: "top-level" }) as LiveTool["sourceInfo"];
const mcpTool = (name: string, server: string, annotations?: LiveTool["annotations"]): LiveTool => ({
	name,
	namespace: { name: `mcp__${server}` },
	sourceInfo: src("builtin:mcp"),
	...(annotations ? { annotations } : {}),
});
const bash: LiveTool = { name: "bash", sourceInfo: src("builtin:bash") };
const WRITE = mcpTool("mcp__t__create_issue", "t", { readOnlyHint: false });
const READ = mcpTool("mcp__t__get_issue", "t", { readOnlyHint: true });

const pack = (...rules: Rule[]): HostPack => ({ id: "p", rules });
const event = (toolName: string, input: unknown = {}, extra: Partial<GuardEvent> = {}): GuardEvent => ({ toolName, toolCallId: `id-${Math.random()}`, input, ...extra });

interface Setup {
	guard: Guard;
	ctx: GuardContext & { dialogs: Array<{ title: string; message: string; timeout?: number }> };
	clock: { now: number };
}

function setup(opts: { packs?: HostPack[]; tools?: LiveTool[]; answer?: boolean | "throw" | "hang-until-timeout"; hasUI?: boolean; timeoutMs?: number } = {}): Setup {
	const clock = { now: 1_000_000 };
	const dialogs: Setup["ctx"]["dialogs"] = [];
	const timeoutMs = opts.timeoutMs ?? 1000;
	const ctx = {
		hasUI: opts.hasUI ?? true,
		dialogs,
		ui: {
			async confirm(title: string, message: string, options?: { timeout?: number }) {
				dialogs.push({ title, message, ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}) });
				if (opts.answer === "throw") throw new Error("ui exploded");
				if (opts.answer === "hang-until-timeout") {
					clock.now += options?.timeout ?? 0;
					return false;
				}
				return opts.answer ?? true;
			},
		},
	};
	const guard = new Guard({
		packs: () => opts.packs ?? [],
		tools: () => opts.tools ?? [WRITE, READ, bash],
		defaults: () => ({ ...SHIPPED_DEFAULTS }),
		now: () => clock.now,
		dialogTimeoutMs: timeoutMs,
	});
	return { guard, ctx, clock };
}

test("allow: a read-only MCP tool and a built-in pass without a dialog", async () => {
	const { guard, ctx } = setup();
	assert.equal(await guard.check(event(READ.name), ctx), undefined);
	assert.equal(await guard.check(event("bash", { command: "ls" }), ctx), undefined);
	assert.equal(ctx.dialogs.length, 0);
});

test("never: blocks, says not to retry, and opens no dialog", async () => {
	const { guard, ctx } = setup({ packs: [pack({ tool: WRITE.name, verdict: "never" })] });
	const r = await guard.check(event(WRITE.name), ctx);
	assert.equal(r?.block, true);
	assert.match(r!.reason!, /never allowed/);
	assert.match(r!.reason!, /Do not retry/);
	assert.equal(ctx.dialogs.length, 0);
});

test("ask: an unannotated write opens one dialog with a timeout, and runs when approved", async () => {
	const { guard, ctx } = setup({ answer: true });
	assert.equal(await guard.check(event(WRITE.name, { summary: "hi" }), ctx), undefined);
	assert.equal(ctx.dialogs.length, 1);
	assert.equal(ctx.dialogs[0]!.timeout, 1000, "every dialog has a timeout");
	assert.match(ctx.dialogs[0]!.message, /summary: hi/);
});

test("ask with no UI: blocked, and the reason tells the model to ask the user", async () => {
	const { guard, ctx } = setup({ hasUI: false });
	const r = await guard.check(event(WRITE.name), ctx);
	assert.equal(r?.block, true);
	assert.match(r!.reason!, /no way to ask/);
	assert.match(r!.reason!, /ask the user in your reply/);
	assert.equal(ctx.dialogs.length, 0);
});

test("declined: blocked, and the reason says not to retry", async () => {
	const { guard, ctx } = setup({ answer: false });
	const r = await guard.check(event(WRITE.name), ctx);
	assert.equal(r?.block, true);
	assert.match(r!.reason!, /declined/);
	assert.match(r!.reason!, /Do not retry/);
});

test("RPC with no client: the dialog times out, and the reason says nobody answered", async () => {
	const { guard, ctx } = setup({ answer: "hang-until-timeout", timeoutMs: 5000 });
	const r = await guard.check(event(WRITE.name), ctx);
	assert.equal(r?.block, true);
	assert.match(r!.reason!, /Nobody answered/);
	assert.doesNotMatch(r!.reason!, /declined/);
});

test("a dialog that throws blocks", async () => {
	const { guard, ctx } = setup({ answer: "throw" });
	const r = await guard.check(event(WRITE.name), ctx);
	assert.equal(r?.block, true);
	assert.match(r!.reason!, /ui exploded/);
});

test("an aborted operation blocks without saying the user declined", async () => {
	const { guard, ctx } = setup({ answer: false });
	const controller = new AbortController();
	controller.abort();
	const r = await guard.check(event(WRITE.name), { ...ctx, signal: controller.signal });
	assert.equal(r?.block, true);
	assert.match(r!.reason!, /aborted/);
});

test("an exception while deciding blocks", async () => {
	const guard = new Guard({
		packs: () => {
			throw new Error("store broke");
		},
		tools: () => [],
		defaults: () => ({ ...SHIPPED_DEFAULTS }),
	});
	const r = await guard.check(event("anything"), { hasUI: true, ui: { confirm: async () => true } });
	assert.equal(r?.block, true);
	assert.match(r!.reason!, /store broke/);
});

test("a tool missing from pi's list asks", async () => {
	const { guard, ctx } = setup({ tools: [], answer: false });
	const r = await guard.check(event("ghost"), ctx);
	assert.equal(r?.block, true);
	assert.equal(ctx.dialogs.length, 1);
});

test("the guard never changes the call's input", async () => {
	const { guard, ctx } = setup({ packs: [pack({ tool: WRITE.name, verdict: "ask", preview: (a: any) => ((a.x = 1), "p") })] });
	const input = { summary: "s", nested: { a: 1 } };
	const before = JSON.stringify(input);
	await guard.check(event(WRITE.name, input), ctx);
	assert.equal(JSON.stringify(input), before);
});

test("an approval window skips the dialog until it ends", async () => {
	const rule: Rule = { tool: WRITE.name, verdict: "ask", windowMs: 60_000 };
	const { guard, ctx, clock } = setup({ packs: [pack(rule)], answer: true });
	assert.equal(await guard.check(event(WRITE.name), ctx), undefined);
	assert.equal(await guard.check(event(WRITE.name), ctx), undefined);
	assert.equal(ctx.dialogs.length, 1, "second call is inside the window");
	assert.equal(guard.approvals().length, 1);
	clock.now += 60_001;
	assert.equal(await guard.check(event(WRITE.name), ctx), undefined);
	assert.equal(ctx.dialogs.length, 2, "window ended, asks again");
});

test("without a window, every call asks", async () => {
	const { guard, ctx } = setup({ answer: true });
	await guard.check(event(WRITE.name), ctx);
	await guard.check(event(WRITE.name), ctx);
	assert.equal(ctx.dialogs.length, 2);
	assert.equal(guard.approvals().length, 0);
});

test("a window covers only the tool and rules it was granted for", async () => {
	const other = mcpTool("mcp__t__edit_issue", "t", { readOnlyHint: false });
	const rules: Rule[] = [{ tool: "mcp__t__*", verdict: "ask", windowMs: 60_000 }];
	const { guard, ctx } = setup({ packs: [pack(...rules)], tools: [WRITE, other], answer: true });
	await guard.check(event(WRITE.name), ctx);
	await guard.check(event(other.name), ctx);
	assert.equal(ctx.dialogs.length, 2, "approving one tool does not approve another");
});

test("a declined dialog grants no window", async () => {
	const rule: Rule = { tool: WRITE.name, verdict: "ask", windowMs: 60_000 };
	const { guard, ctx } = setup({ packs: [pack(rule)], answer: false });
	await guard.check(event(WRITE.name), ctx);
	assert.equal(guard.approvals().length, 0);
});

test("clearApprovals drops every window", async () => {
	const rule: Rule = { tool: WRITE.name, verdict: "ask", windowMs: 60_000 };
	const { guard, ctx } = setup({ packs: [pack(rule)], answer: true });
	await guard.check(event(WRITE.name), ctx);
	guard.clearApprovals();
	await guard.check(event(WRITE.name), ctx);
	assert.equal(ctx.dialogs.length, 2);
});

test("a never rule still blocks inside a window granted by an ask rule", async () => {
	const ask: Rule = { tool: WRITE.name, verdict: "ask", windowMs: 60_000 };
	const never: Rule = { tool: WRITE.name, args: { summary: "danger" }, verdict: "never" };
	const { guard, ctx } = setup({ packs: [pack(ask, never)], answer: true });
	await guard.check(event(WRITE.name, { summary: "fine" }), ctx);
	const r = await guard.check(event(WRITE.name, { summary: "danger" }), ctx);
	assert.equal(r?.block, true);
});

test("a nested call is gated like a top-level one", async () => {
	const { guard, ctx } = setup({ answer: false });
	guard.noteStart("p1", "codemode");
	const r = await guard.check(event(WRITE.name, {}, { toolCallId: "p1/1", parentToolCallId: "p1" }), ctx);
	assert.equal(r?.block, true);
	assert.equal(ctx.dialogs.length, 1);
});

test("a nested call from a trusted parent skips the dialog; from any other parent it does not", async () => {
	const rule: Rule = { tool: WRITE.name, verdict: "ask", trustedParents: ["confirmed_tool"] };
	const { guard, ctx } = setup({ packs: [pack(rule)], answer: false });
	guard.noteStart("p1", "confirmed_tool");
	guard.noteStart("p2", "codemode");
	assert.equal(await guard.check(event(WRITE.name, {}, { toolCallId: "p1/1", parentToolCallId: "p1" }), ctx), undefined);
	assert.equal(ctx.dialogs.length, 0);
	const r = await guard.check(event(WRITE.name, {}, { toolCallId: "p2/1", parentToolCallId: "p2" }), ctx);
	assert.equal(r?.block, true);
	assert.equal(ctx.dialogs.length, 1);
});

test("trusted parents never apply when the parent is unknown, ended, or a rule does not trust it", async () => {
	const trusting: Rule = { tool: WRITE.name, verdict: "ask", trustedParents: ["confirmed_tool"] };
	const plain: Rule = { tool: "mcp__t__*", verdict: "ask" };
	const { guard, ctx } = setup({ packs: [pack(trusting, plain)], answer: false });
	guard.noteStart("p1", "confirmed_tool");
	const mixed = await guard.check(event(WRITE.name, {}, { toolCallId: "p1/1", parentToolCallId: "p1" }), ctx);
	assert.equal(mixed?.block, true, "one deciding rule does not trust it");
	guard.noteEnd("p1");
	const gone = await guard.check(event(WRITE.name, {}, { toolCallId: "p1/2", parentToolCallId: "p1" }), ctx);
	assert.equal(gone?.block, true, "parent is no longer running");
	const unknown = await guard.check(event(WRITE.name, {}, { toolCallId: "zz/1", parentToolCallId: "zz" }), ctx);
	assert.equal(unknown?.block, true);
});

test("a trusted parent never lifts a never rule", async () => {
	const rule: Rule = { tool: WRITE.name, verdict: "never" };
	const { guard, ctx } = setup({ packs: [pack(rule)] });
	guard.noteStart("p1", "confirmed_tool");
	const r = await guard.check(event(WRITE.name, {}, { toolCallId: "p1/1", parentToolCallId: "p1" }), ctx);
	assert.equal(r?.block, true);
});

test("parallel asks are shown one at a time", async () => {
	let open = 0;
	let maxOpen = 0;
	const ctx: GuardContext = {
		hasUI: true,
		ui: {
			async confirm() {
				maxOpen = Math.max(maxOpen, ++open);
				await new Promise((r) => setTimeout(r, 5));
				open--;
				return true;
			},
		},
	};
	const guard = new Guard({ packs: () => [], tools: () => [WRITE], defaults: () => ({ ...SHIPPED_DEFAULTS }) });
	await Promise.all([1, 2, 3].map((i) => guard.check(event(WRITE.name, { i }), ctx)));
	assert.equal(maxOpen, 1);
});

test("parallel calls inside a window: the first dialog's approval covers the rest", async () => {
	const rule: Rule = { tool: WRITE.name, verdict: "ask", windowMs: 60_000 };
	const { guard, ctx } = setup({ packs: [pack(rule)], answer: true });
	await Promise.all([1, 2, 3].map(() => guard.check(event(WRITE.name), ctx)));
	assert.equal(ctx.dialogs.length, 1);
});

test("a UI that ignores the dialog timeout cannot stall later asks", async () => {
	const ctx: GuardContext = { hasUI: true, ui: { confirm: () => new Promise<boolean>(() => {}) } };
	const guard = new Guard({ packs: () => [], tools: () => [WRITE], defaults: () => ({ ...SHIPPED_DEFAULTS }), dialogTimeoutMs: 10, dialogGraceMs: 20 });
	const first = await guard.check(event(WRITE.name), ctx);
	assert.equal(first?.block, true);
	assert.match(first!.reason!, /did not answer in time/);
	const second = await guard.check(event(WRITE.name), ctx);
	assert.equal(second?.block, true, "the queue moved on");
});

test("a call queued behind a dialog does not open its own after the operation was aborted", async () => {
	const controller = new AbortController();
	let opened = 0;
	const ctx: GuardContext = {
		hasUI: true,
		signal: controller.signal,
		ui: {
			async confirm() {
				opened++;
				if (opened === 1) {
					controller.abort();
					return false;
				}
				return true;
			},
		},
	};
	const guard = new Guard({ packs: () => [], tools: () => [WRITE], defaults: () => ({ ...SHIPPED_DEFAULTS }) });
	const [a, b, c] = await Promise.all([1, 2, 3].map((i) => guard.check(event(WRITE.name, { i }), ctx)));
	assert.equal(opened, 1, "later calls never opened a dialog");
	assert.ok(a?.block && b?.block && c?.block);
	assert.match(b!.reason!, /aborted/);
});

test("a later ask still works after a dialog rejected", async () => {
	let n = 0;
	const ctx: GuardContext = {
		hasUI: true,
		ui: {
			async confirm() {
				if (n++ === 0) throw new Error("first one failed");
				return true;
			},
		},
	};
	const guard = new Guard({ packs: () => [], tools: () => [WRITE], defaults: () => ({ ...SHIPPED_DEFAULTS }) });
	assert.equal((await guard.check(event(WRITE.name), ctx))?.block, true);
	assert.equal(await guard.check(event(WRITE.name), ctx), undefined);
});

test("a call id used for two different tools names neither as a trusted parent", async () => {
	const rule: Rule = { tool: WRITE.name, verdict: "ask", trustedParents: ["confirmed_tool"] };
	const { guard, ctx } = setup({ packs: [pack(rule)], answer: false });
	guard.noteStart("p1", "confirmed_tool");
	guard.noteStart("p1", "codemode");
	const r = await guard.check(event(WRITE.name, {}, { toolCallId: "p1/1", parentToolCallId: "p1" }), ctx);
	assert.equal(r?.block, true);
	guard.noteStart("p2", "confirmed_tool");
	guard.noteStart("p2", "confirmed_tool");
	assert.equal(await guard.check(event(WRITE.name, {}, { toolCallId: "p2/1", parentToolCallId: "p2" }), ctx), undefined, "the same tool twice is fine");
});

test("the reason text is made visible", async () => {
	const evil = `bad\x1b[2Jname`;
	const { guard, ctx } = setup({ tools: [], answer: false, hasUI: false });
	const r = await guard.check(event(evil), ctx);
	assert.ok(!r!.reason!.includes("\x1b"));
});
