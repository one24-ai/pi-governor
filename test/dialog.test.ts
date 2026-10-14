/**
 * Approval text and sanitizing: what the user sees must be what is sent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDialog, effectiveWindowMs, formatDuration, hiddenArguments, MAX_BODY_CHARS, MAX_VALUE_CHARS, renderArguments } from "../extensions/governor/dialog.ts";
import type { Decision, Rule } from "../extensions/governor/rules.ts";
import { clipVisible, visible } from "../extensions/governor/sanitize.ts";

const decision = (rules: Rule[] = [], why = "the tool does not declare readOnlyHint"): Decision => ({ verdict: "ask", source: "mcp", rules, why });
const ESC = "\x1b";

test("visible: escapes, bidi and invisible characters become markers", () => {
	assert.equal(visible(`${ESC}]52;c;ZXZpbA==\x07x`), "<U+001B>]52;c;ZXZpbA==<U+0007>x");
	assert.equal(visible("a\u202eb"), "a<U+202E>b");
	assert.equal(visible("a\u200bb\ufeffc\u00add"), "a<U+200B>b<U+FEFF>c<U+00AD>d");
	assert.equal(visible("\x9b31m"), "<U+009B>31m");
	assert.equal(visible("a\x00b\x7fc"), "a<U+0000>b<U+007F>c");
	assert.equal(visible("lone \ud800 surrogate"), "lone <U+D800> surrogate");
	assert.equal(visible("emoji \u{1F600} ok"), "emoji \u{1F600} ok");
	assert.equal(visible("plain text"), "plain text");
});

test("visible: invisible characters that hide content are marked", () => {
	const cases: Array<[string, string]> = [
		["\u200c", "<U+200C>"],
		["\u200d", "<U+200D>"],
		["\ufe0f", "<U+FE0F>"],
		["\u034f", "<U+034F>"],
		["\u3164", "<U+3164>"],
		["\u115f", "<U+115F>"],
		["\uffa0", "<U+FFA0>"],
		["\u2800", "<U+2800>"],
		["\u2063", "<U+2063>"],
		["\u{e0072}", "<U+E0072>"],
		["\u{e0001}", "<U+E0001>"],
		["\u{e0100}", "<U+E0100>"],
		["\u{1d173}", "<U+1D173>"],
	];
	for (const [raw, shown] of cases) assert.equal(visible(`a${raw}b`), `a${shown}b`, shown);
	// A hidden message in tag characters is spelled out, not lost.
	const hidden = [..."rm"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
	assert.equal(visible(`ls${hidden}`), "ls<U+E0072><U+E006D>");
	assert.equal(visible("\u{1F600}\u{1F468}\u200d\u{1F469}"), "\u{1F600}\u{1F468}<U+200D>\u{1F469}");
});

test("visible: breaks stay only when asked, and a lone CR never does", () => {
	assert.equal(visible("a\nb\tc", true), "a\nb\tc");
	assert.equal(visible("a\r\nb", true), "a\nb");
	assert.equal(visible("a\rb", true), "a<U+000D>b");
	assert.equal(visible("a\nb\tc"), "a<U+000A>b<U+0009>c");
	assert.equal(visible("a\u2028b", true), "a<U+2028>b");
});

test("clipVisible reports the full length and never splits a surrogate pair", () => {
	const r = clipVisible("x".repeat(500), 300);
	assert.equal(r.total, 500);
	assert.equal(r.clipped, true);
	assert.equal(r.text.length, 300);
	const pair = clipVisible("a\u{1F600}b", 2);
	assert.equal(pair.text, "a");
	assert.equal(pair.total, 4);
	assert.equal(clipVisible("short", 10).clipped, false);
});

test("a clipped value states its full length", () => {
	const out = renderArguments({ body: "y".repeat(1000) });
	assert.match(out, /1000 characters in total/);
	assert.ok(out.includes("y".repeat(MAX_VALUE_CHARS)));
	assert.ok(!out.includes("y".repeat(MAX_VALUE_CHARS + 1)));
});

test("every argument is listed, and extra ones are counted", () => {
	const input = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
	const out = renderArguments(input);
	assert.match(out, /k0: 0/);
	assert.match(out, /k19: 19/);
	assert.match(out, /5 more arguments not shown/);
	assert.equal(renderArguments({}), "(no arguments)");
});

test("a multi-line value cannot pass a line of its own off as another argument", () => {
	const out = renderArguments({ note: "hello\napproved: yes" });
	assert.equal(out, "note: hello\n  approved: yes");
});

test("a hostile key name is made visible and clipped", () => {
	const out = renderArguments({ [`${ESC}[2Jevil`]: "v", ["k".repeat(200)]: "w" });
	assert.ok(!out.includes(ESC));
	assert.match(out, /<U\+001B>\[2Jevil: v/);
	assert.match(out, /name is 200 characters/);
});

test("values that cannot be shown are said so, not dropped", () => {
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const out = renderArguments({ a: circular, b: 10n });
	assert.match(out, /a: \(could not be shown: object\)/);
	assert.match(out, /b: \(could not be shown: bigint\)/);
});

test("non-object input is shown, not hidden", () => {
	assert.match(renderArguments("just a string"), /Arguments: just a string/);
	assert.match(renderArguments(["a", "b"]), /Arguments: \["a","b"\]/);
	assert.match(renderArguments(null), /Arguments: null/);
});

test("a rule preview is shown, and arguments it leaves out are listed", () => {
	const rule: Rule = { tool: "t", verdict: "ask", preview: (a: any) => `Add comment to issue: ${a.issue}` };
	const d = buildDialog({ toolName: "t", input: { issue: "ABC-1", body: "secret payload", visibility: "public" }, decision: decision([rule]) });
	assert.match(d.message, /Add comment to issue: ABC-1/);
	assert.match(d.message, /Not shown in the preview above: body \(14 characters\), visibility \(6 characters\)/);
	assert.ok(!d.message.includes("secret payload"));
});

test("a preview that shows every argument adds no warning", () => {
	const rule: Rule = { tool: "t", verdict: "ask", preview: (a: any) => `issue: ${a.issue}\nbody: ${a.body}` };
	const d = buildDialog({ toolName: "t", input: { issue: "ABC-1", body: "hello" }, decision: decision([rule]) });
	assert.ok(!d.message.includes("Not shown"));
});

test("a short value in a preview that does not name its argument is listed, which costs a line and hides nothing", () => {
	const rule: Rule = { tool: "t", verdict: "ask", preview: (a: any) => `Add comment to ${a.issue}` };
	const d = buildDialog({ toolName: "t", input: { issue: "ABC-1" }, decision: decision([rule]) });
	assert.match(d.message, /Not shown in the preview above: issue \(5 characters\)/);
});

test("a preview that fails falls back to the full argument list", () => {
	const rule: Rule = {
		tool: "t",
		verdict: "ask",
		preview: () => {
			throw new Error("boom");
		},
	};
	const d = buildDialog({ toolName: "t", input: { body: "payload" }, decision: decision([rule]) });
	assert.match(d.message, /body: payload/);
	assert.match(d.message, /preview failed/);
});

test("a preview that returns a non-string falls back too", () => {
	const rule: Rule = { tool: "t", verdict: "ask", preview: (() => 42) as any };
	const d = buildDialog({ toolName: "t", input: { body: "payload" }, decision: decision([rule]) });
	assert.match(d.message, /body: payload/);
});

test("a preview cannot change the arguments the call is sent with", () => {
	const input = { body: "payload", nested: { a: 1 } };
	const rule: Rule = {
		tool: "t",
		verdict: "ask",
		preview: (a: any) => {
			a.body = "tampered";
			a.nested.a = 2;
			return "x";
		},
	};
	buildDialog({ toolName: "t", input, decision: decision([rule]) });
	assert.deepEqual(input, { body: "payload", nested: { a: 1 } });
});

test("preview text is made visible too", () => {
	const rule: Rule = { tool: "t", verdict: "ask", preview: () => `ok${ESC}]0;title\x07` };
	const d = buildDialog({ toolName: "t", input: {}, decision: decision([rule]) });
	assert.ok(!d.message.includes(ESC));
	assert.ok(!d.message.includes("\x07"));
});

test("a long body is shortened and says by how much", () => {
	const rule: Rule = { tool: "t", verdict: "ask", preview: () => "z".repeat(MAX_BODY_CHARS + 500) };
	const d = buildDialog({ toolName: "t", input: {}, decision: decision([rule]) });
	assert.match(d.message, new RegExp(`first ${MAX_BODY_CHARS} of ${MAX_BODY_CHARS + 500} characters`));
});

test("with two rules deciding, every preview is shown", () => {
	const a: Rule = { tool: "t", verdict: "ask", preview: () => "first preview" };
	const b: Rule = { tool: "t", verdict: "ask", preview: () => "second preview" };
	const d = buildDialog({ toolName: "t", input: {}, decision: decision([a, b]) });
	assert.match(d.message, /first preview/);
	assert.match(d.message, /second preview/);
});

test("if one deciding rule has a preview and another does not, nothing is hidden", () => {
	const a: Rule = { tool: "t", verdict: "ask", preview: () => "only a summary" };
	const b: Rule = { tool: "t", verdict: "ask" };
	const d = buildDialog({ toolName: "t", input: { body: "payload" }, decision: decision([a, b]) });
	assert.match(d.message, /only a summary/);
	assert.match(d.message, /Not shown in the preview above: body/);
});

test("the title names the tool, visibly", () => {
	const d = buildDialog({ toolName: `bad${ESC}[2Jname`, input: {}, decision: decision() });
	assert.ok(!d.title.includes(ESC));
	assert.match(d.title, /^Allow bad<U\+001B>\[2Jname\?$/);
});

test("the dialog says why, and states a window when every rule has one", () => {
	const withWindow: Rule = { tool: "t", verdict: "ask", windowMs: 15 * 60_000 };
	assert.match(buildDialog({ toolName: "t", input: {}, decision: decision([withWindow], "a rule for t") }).message, /next 15 minutes/);
	const without: Rule = { tool: "t", verdict: "ask" };
	const mixed = buildDialog({ toolName: "t", input: {}, decision: decision([withWindow, without]) });
	assert.ok(!mixed.message.includes("without asking"));
	assert.match(mixed.message, /Why you are asked/);
});

test("effectiveWindowMs is the shortest window, or none if any rule asks every time", () => {
	assert.equal(effectiveWindowMs([]), undefined);
	assert.equal(effectiveWindowMs([{ windowMs: 1000 }, { windowMs: 500 }] as Rule[]), 500);
	assert.equal(effectiveWindowMs([{ windowMs: 1000 }, {}] as Rule[]), undefined);
});

test("formatDuration", () => {
	assert.equal(formatDuration(1000), "1 second");
	assert.equal(formatDuration(90_000), "90 seconds");
	assert.equal(formatDuration(15 * 60_000), "15 minutes");
	assert.equal(formatDuration(3 * 3_600_000), "3 hours");
});

test("hiddenArguments finds string and non-string values", () => {
	assert.deepEqual(hiddenArguments({ a: "a long enough value", b: { x: 1 }, c: [1] }, "Create a long enough value"), ["b (object)", "c (list)"]);
	assert.deepEqual(hiddenArguments("x", "x"), []);
});

test("hiddenArguments: a short value is not shown just because its letters appear in the preview", () => {
	assert.deepEqual(hiddenArguments({ title: "hi", force: true }, "Create: hi (true story)"), ["title (2 characters)", "force (boolean)"]);
	assert.deepEqual(hiddenArguments({ priority: "a" }, "a banana"), ["priority (1 characters)"]);
	assert.deepEqual(hiddenArguments({ note: "" }, "anything at all"), ["note (0 characters)"]);
	assert.deepEqual(hiddenArguments({ n: 5 }, "5 items"), ["n (number)"]);
});

test("hiddenArguments: a short value counts as shown when the preview names its argument and contains it", () => {
	assert.deepEqual(hiddenArguments({ title: "hi" }, "title: hi"), []);
	assert.deepEqual(hiddenArguments({ force: true }, "force: true"), []);
	assert.deepEqual(hiddenArguments({ note: "" }, "note is empty"), []);
});

test("hiddenArguments: a long value is shown by appearing in the preview", () => {
	assert.deepEqual(hiddenArguments({ body: "this is the whole body" }, "Comment: this is the whole body"), []);
	assert.deepEqual(hiddenArguments({ body: "this is the whole body" }, "Comment: this is"), ["body (22 characters)"]);
});
