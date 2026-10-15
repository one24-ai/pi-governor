/**
 * Argument freezing: the guard freezes what it let through, so a handler loaded after it cannot
 * change what the tool receives. See docs/design.md, Findings and "Care needed".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deepFreeze } from "../extensions/governor/freeze.ts";
import { Guard, type GuardContext } from "../extensions/governor/guard.ts";
import type { HostPack } from "../extensions/governor/registry.ts";
import { type LiveTool, parseConfig, type Rule, resolveFreeze, SHIPPED_DEFAULTS } from "../extensions/governor/rules.ts";

const src = (path: string) => ({ path, source: "x", scope: "user", origin: "top-level" }) as LiveTool["sourceInfo"];
const READ: LiveTool = { name: "mcp__t__get", namespace: { name: "mcp__t" }, annotations: { readOnlyHint: true }, sourceInfo: src("builtin:mcp") };
const WRITE: LiveTool = { name: "mcp__t__put", namespace: { name: "mcp__t" }, annotations: { readOnlyHint: false }, sourceInfo: src("builtin:mcp") };
const BASH: LiveTool = { name: "bash", sourceInfo: src("builtin:bash") };
const ctx = (answer = true): GuardContext => ({ hasUI: true, ui: { confirm: async () => answer } });
const guard = (over: { freeze?: () => boolean; rules?: Rule[] } = {}) =>
	new Guard({
		packs: () => (over.rules ? [{ id: "p", rules: over.rules } as HostPack] : []),
		tools: () => [READ, WRITE, BASH],
		defaults: () => ({ ...SHIPPED_DEFAULTS }),
		...(over.freeze ? { freezeArguments: over.freeze } : {}),
	});
const ev = (toolName: string, input: unknown) => ({ toolName, toolCallId: "c1", input });

// ---- deepFreeze ------------------------------------------------------------------------------

test("deepFreeze freezes nested objects and arrays", () => {
	const input = { a: { b: [1, { c: 2 }] }, d: "x" };
	deepFreeze(input);
	assert.ok(Object.isFrozen(input) && Object.isFrozen(input.a) && Object.isFrozen(input.a.b) && Object.isFrozen(input.a.b[1]));
	assert.throws(() => {
		input.a.b.push(3);
	}, TypeError);
	assert.throws(() => {
		(input as any).d = "y";
	}, TypeError);
});

test("deepFreeze handles cycles, shared references, primitives and a very deep value", () => {
	const a: any = { name: "a" };
	a.self = a;
	deepFreeze(a);
	assert.ok(Object.isFrozen(a));
	deepFreeze("text");
	deepFreeze(null);
	deepFreeze(undefined);
	deepFreeze(42);
	let deep: any = { leaf: true };
	for (let i = 0; i < 50_000; i++) deep = { next: deep };
	deepFreeze(deep);
	assert.ok(Object.isFrozen(deep));
});

test("deepFreeze never calls a getter, and refuses the accessor instead", () => {
	let called = 0;
	const o = {
		get x() {
			called++;
			return { y: 1 };
		},
	};
	assert.throws(() => deepFreeze(o), /accessor/);
	assert.equal(called, 0);
});

test("deepFreeze throws for an object that refuses to be frozen", () => {
	const refusing = new Proxy({}, { preventExtensions: () => false, isExtensible: () => true });
	assert.throws(() => deepFreeze({ inner: refusing }));
});

test("deepFreeze refuses values that Object.freeze cannot make immutable", () => {
	const cases: Array<[string, unknown, RegExp]> = [
		["Map", new Map([["k", { v: 1 }]]), /Map or Set/],
		["Set", new Set([1]), /Map or Set/],
		["WeakMap", new WeakMap(), /Map or Set/],
		["Date", new Date(0), /Date/],
		["non-empty Uint8Array", new Uint8Array(3), /binary data/],
		["empty Uint8Array", new Uint8Array(0), /binary data/],
		["Buffer", Buffer.from("ab"), /binary data/],
		["DataView", new DataView(new ArrayBuffer(2)), /binary data/],
		["ArrayBuffer", new ArrayBuffer(2), /binary data/],
		["Proxy", new Proxy({}, {}), /Proxy/],
		["getter", Object.defineProperty({}, "x", { get: () => 1, enumerable: true }), /accessor/],
		["setter", Object.defineProperty({}, "x", { set: () => {}, enumerable: true }), /accessor/],
		["function value", { f: () => 1 }, /function/],
	];
	for (const [name, value, why] of cases) {
		assert.throws(() => deepFreeze({ nested: [value] }), why, name);
		assert.throws(() => deepFreeze(value), why, `${name} at the top`);
	}
	assert.throws(() => deepFreeze(() => 1), /function/);
});

test("deepFreeze still accepts every kind of plain data", () => {
	const input = { s: "x", n: 1, b: true, nil: null, u: undefined, big: 10n, arr: [1, [2, { x: 3 }]], nested: { deep: { deeper: [] } }, sym: Symbol.for("k") };
	deepFreeze(input);
	assert.ok(Object.isFrozen(input.nested.deep.deeper));
	const sparse = [1, , 3];
	deepFreeze(sparse);
	assert.ok(Object.isFrozen(sparse));
	const noProto = Object.create(null);
	noProto.k = { v: 1 };
	deepFreeze(noProto);
	assert.ok(Object.isFrozen(noProto.k));
});

test("deepFreeze on a large array of primitives stays fast", () => {
	const big = Array.from({ length: 500_000 }, (_, i) => i);
	const start = Date.now();
	deepFreeze(big);
	assert.ok(Date.now() - start < 3000, "500,000 elements should take well under 3 seconds");
	assert.ok(Object.isFrozen(big));
});

// ---- guard -----------------------------------------------------------------------------------

test("a call the guard lets through has frozen arguments by default", async () => {
	const input = { id: "1", nested: { tags: ["a"] } };
	assert.equal(await guard().check(ev(READ.name, input), ctx()), undefined);
	assert.ok(Object.isFrozen(input) && Object.isFrozen(input.nested) && Object.isFrozen(input.nested.tags));
	assert.throws(() => {
		(input as any).id = "2";
	}, TypeError);
});

test("an allowed built-in call is frozen too, and an approved ask call", async () => {
	const bashInput = { command: "ls" };
	await guard().check(ev("bash", bashInput), ctx());
	assert.ok(Object.isFrozen(bashInput));
	const writeInput = { text: "hi" };
	assert.equal(await guard().check(ev(WRITE.name, writeInput), ctx(true)), undefined);
	assert.ok(Object.isFrozen(writeInput));
});

test("the arguments are frozen before the decision, so a blocked call is frozen too", async () => {
	const input = { text: "hi" };
	const r = await guard().check(ev(WRITE.name, input), ctx(false));
	assert.equal(r?.block, true);
	assert.equal(Object.isFrozen(input), true, "nothing runs for a blocked call, so freezing it costs nothing");
});

test("a handler that kept a reference cannot change the arguments while the dialog is open", async () => {
	const input = { text: "approved text" };
	let changedWhileOpen: unknown = "not tried";
	const answer: GuardContext = {
		hasUI: true,
		ui: {
			async confirm() {
				try {
					input.text = "something else";
					changedWhileOpen = "changed";
				} catch (error) {
					changedWhileOpen = (error as Error).constructor.name;
				}
				return true;
			},
		},
	};
	assert.equal(await guard().check(ev(WRITE.name, input), answer), undefined);
	assert.equal(changedWhileOpen, "TypeError");
	assert.equal(input.text, "approved text");
});

test("the dialog shows the frozen values, which are the ones the tool receives", async () => {
	const input = { text: "shown" };
	let shown = "";
	const answer: GuardContext = { hasUI: true, ui: { confirm: async (_t, m) => ((shown = m), true) } };
	await guard().check(ev(WRITE.name, input), answer);
	assert.match(shown, /text: shown/);
	assert.throws(() => {
		input.text = "different";
	}, TypeError);
});

test("with freezing off, arguments are left alone", async () => {
	const input = { id: "1" };
	await guard({ freeze: () => false }).check(ev(READ.name, input), ctx());
	assert.equal(Object.isFrozen(input), false);
});

test("the setting is read for every call", async () => {
	let on = false;
	const g = guard({ freeze: () => on });
	const first = { id: "1" };
	await g.check(ev(READ.name, first), ctx());
	on = true;
	const second = { id: "2" };
	await g.check(ev(READ.name, second), ctx());
	assert.deepEqual([Object.isFrozen(first), Object.isFrozen(second)], [false, true]);
});

test("input that cannot be frozen blocks the call, before any dialog or rule", async () => {
	const refusing = new Proxy({}, { preventExtensions: () => false, isExtensible: () => true });
	let asked = 0;
	const counting: GuardContext = { hasUI: true, ui: { confirm: async () => (asked++, true) } };
	for (const bad of [refusing, new Map(), new Date(), new Uint8Array(2), { f() {} }]) {
		const r = await guard().check(ev(WRITE.name, { inner: bad }), counting);
		assert.equal(r?.block, true);
		assert.match(r!.reason!, /could not freeze the arguments/);
		assert.match(r!.reason!, /Do not retry/);
	}
	assert.equal(asked, 0);
});

test("with freezing off, input that could not be frozen is still checked normally", async () => {
	assert.equal(await guard({ freeze: () => false }).check(ev(READ.name, { when: new Date(0), tags: new Set(["a"]) }), ctx()), undefined);
});

test("a freezeArguments() that throws blocks the call", async () => {
	const g = guard({
		freeze: () => {
			throw new Error("setting unavailable");
		},
	});
	const r = await g.check(ev(READ.name, { id: "1" }), ctx());
	assert.equal(r?.block, true);
	assert.match(r!.reason!, /setting unavailable/);
});

test("trusted-parent and held-approval calls are frozen", async () => {
	const rule: Rule = { tool: WRITE.name, verdict: "ask", windowMs: 60_000, trustedParents: ["confirmed"] };
	const g = guard({ rules: [rule] });
	await g.check(ev(WRITE.name, { text: "first" }), ctx(true));
	const held = { text: "second" };
	assert.equal(await g.check(ev(WRITE.name, held), ctx(false)), undefined, "inside the window");
	assert.equal(Object.isFrozen(held), true);
	g.noteStart("p1", "confirmed");
	const nested = { text: "third" };
	assert.equal(await g.check({ ...ev(WRITE.name, nested), parentToolCallId: "p1" }, ctx(false)), undefined);
	assert.equal(Object.isFrozen(nested), true);
});

test("a sloppy-mode write to frozen arguments is ignored, so the checked value stands", async () => {
	const input = { text: "safe" };
	await guard().check(ev(READ.name, input), ctx());
	// An indirect eval runs as sloppy-mode code.
	(0, eval)("(function (o) { o.text = 'danger'; })")(input);
	assert.equal(input.text, "safe");
});

test("a handler that runs after the guard and edits the arguments fails; one that runs before is seen", async () => {
	const rule: Rule = { tool: READ.name, args: { text: "danger" }, verdict: "never" };
	const lateEdit = (input: any) => {
		input.text = "danger";
	};
	// Guard first, edit after.
	const after = { text: "safe" };
	assert.equal(await guard({ rules: [rule] }).check(ev(READ.name, after), ctx()), undefined);
	assert.throws(() => lateEdit(after), TypeError, "the late edit throws instead of changing the arguments");
	assert.equal(after.text, "safe");
	// Edit first, guard after: the guard checks what will be sent.
	const before = { text: "safe" };
	lateEdit(before);
	assert.equal((await guard({ rules: [rule] }).check(ev(READ.name, before), ctx()))?.block, true);
});

test("non-object input does not break the guard", async () => {
	for (const input of [undefined, null, "text", 5, ["a"]]) {
		assert.equal(await guard().check(ev("bash", input), ctx()), undefined, String(input));
	}
});

// ---- the setting -----------------------------------------------------------------------------

test("parseConfig accepts freezeArguments only as a boolean", () => {
	assert.deepEqual(parseConfig('{"freezeArguments":false}'), { ok: true, defaults: {}, freezeArguments: false });
	assert.deepEqual(parseConfig('{"freezeArguments":true,"defaults":{"mcp":"ask"}}'), { ok: true, defaults: { mcp: "ask" }, freezeArguments: true });
	assert.equal(parseConfig('{"freezeArguments":"no"}').ok, false);
	assert.equal(parseConfig('{"freezeArguments":0}').ok, false);
	assert.equal(parseConfig('{"freezeArguments":null}').ok, false);
	assert.equal(parseConfig('{"freezeArgument":false}').ok, false, "a typo is an error, not a silent default");
});

test("resolveFreeze: on by default; only the global file turns it off; a broken file keeps it on", () => {
	const off = parseConfig('{"freezeArguments":false}');
	const on = parseConfig('{"freezeArguments":true}');
	const none = parseConfig("{}");
	assert.equal(resolveFreeze().enabled, true);
	assert.equal(resolveFreeze(none, none).enabled, true);
	assert.equal(resolveFreeze(off).enabled, false);
	assert.equal(resolveFreeze(off, none).enabled, false);
	assert.equal(resolveFreeze(on, none).enabled, true);
	assert.equal(resolveFreeze(undefined, off).enabled, true, "a project file cannot turn it off");
	assert.match(resolveFreeze(undefined, off).reason, /ignored/);
	assert.equal(resolveFreeze(off, off).enabled, false, "the global off stands");
	assert.equal(resolveFreeze(off, on).enabled, true, "a project file can turn it on");
	assert.equal(resolveFreeze(parseConfig("{ nope"), undefined).enabled, true);
	assert.equal(resolveFreeze(off, parseConfig("{ nope")).enabled, true, "a broken project file keeps it on even if global is off");
});
