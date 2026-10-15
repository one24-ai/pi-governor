/**
 * Rules, source defaults and the verdict for one call. Pure: no pi runtime, no I/O. The guard host
 * feeds it the call, the live tool list and the registered rules.
 *
 * See docs/design.md: "Rules", "Default for tools no rule names", "Config" and "Match on the name
 * pi registers".
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { computeMcpToolNames, stripHashSuffix } from "./names.ts";

export type Verdict = "allow" | "ask" | "never";
export type SourceDefault = Verdict | "hints";
export type ToolSource = "mcp" | "builtin" | "extension" | "unknown";
export type ConfigurableSource = Exclude<ToolSource, "unknown">;

/** Values a rule can narrow by: top-level argument fields compared with `===`. */
export type ArgValue = string | number | boolean | null;

export interface Rule {
	/** A registered tool name or `*` pattern, or a server and tool by their original names. */
	tool: string | { server: string; tool: string };
	/** Only when every listed top-level argument field equals the given value. */
	args?: Record<string, ArgValue>;
	/**
	 * Narrow by a check on the arguments, together with `args` (both must hold). Synchronous. It is
	 * not called when the input is not a plain object. Fail closed: `true` is a match and `false` is
	 * no match; a throw, a Promise or any other non-boolean counts as a match for `ask` and `never`
	 * rules (stricter) and as no match for an `allow` rule. A rule with `windowMs` that has a `when`
	 * is approved once for every call it matches in the window, not once per argument value.
	 */
	when?: (args: unknown) => boolean;
	verdict: Verdict;
	/** For `never`: why, added to the block message after the instruction not to retry. */
	reason?: string;
	/** For `ask`: the dialog title, instead of "Allow <tool>?". */
	title?: string;
	/** For `ask`: the text the dialog shows for these arguments. */
	preview?: (args: unknown) => string;
	/** For `ask`: approvals of this rule last this many milliseconds. Without it, every call asks. */
	windowMs?: number;
	/** Tools trusted to have asked already: nested calls they make skip this rule's dialog. */
	trustedParents?: string[];
}

/** The fields of `pi.getAllTools()` the layer reads. */
export type LiveTool = Pick<ToolInfo, "name" | "namespace" | "annotations" | "sourceInfo">;

const RANK: Record<SourceDefault, number> = { allow: 0, hints: 1, ask: 2, never: 3 };
const VERDICT_RANK: Record<Verdict, number> = { allow: 0, ask: 1, never: 2 };

/** Longest `reason` of a `never` rule, in characters. */
export const MAX_REASON_CHARS = 500;
/** Longest `title` of an `ask` rule, in characters. */
export const MAX_TITLE_CHARS = 100;

export const SOURCES: readonly ConfigurableSource[] = ["mcp", "builtin", "extension"];

/** pi's built-in tools (dist/core/tools/index.js, the same in 1.1 and 1.2). */
export const BUILTIN_TOOLS: ReadonlySet<string> = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
export const SHIPPED_DEFAULTS: Readonly<Record<ConfigurableSource, SourceDefault>> = Object.freeze({
	mcp: "hints",
	builtin: "allow",
	extension: "allow",
});

/** The stricter of two source defaults, in the order allow < hints < ask < never. */
export function stricterDefault(a: SourceDefault, b: SourceDefault): SourceDefault {
	return RANK[a] >= RANK[b] ? a : b;
}

function stricterVerdict(a: Verdict, b: Verdict): Verdict {
	return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

/** `mcp__<server>` with `-` replaced, the way pi builds an MCP tool's `namespace`. */
export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}

export function classify(name: string, tool: LiveTool | undefined): ToolSource {
	if (!tool) return "unknown";
	if (name.startsWith("mcp__") || tool.namespace?.name.startsWith("mcp__")) return "mcp";
	// Both checks: pi's built-in extensions also have `builtin:<name>` paths, and `builtin:codemode`
	// registers a tool named `codemode`.
	if (BUILTIN_TOOLS.has(name) && tool.sourceInfo?.path === `builtin:${name}`) return "builtin";
	return "extension";
}

// ---- config ----------------------------------------------------------------------------------

export type ParsedConfig =
	| { ok: true; defaults: Partial<Record<ConfigurableSource, SourceDefault>>; freezeArguments?: boolean }
	| { ok: false; error: string };

/**
 * Parse a governor.json. Only `defaults` (`{ "<source>": "<value>" }`) and `freezeArguments`
 * (true or false) are accepted. Unknown keys and values are errors, so a typo cannot quietly
 * leave a source at a looser default or leave freezing off.
 */
export function parseConfig(text: string): ParsedConfig {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: `not valid JSON: ${(error as Error).message}` };
	}
	if (!isRecord(data)) return { ok: false, error: "top level must be an object" };
	for (const key of Object.keys(data)) if (key !== "defaults" && key !== "freezeArguments") return { ok: false, error: `unknown key "${key}"` };
	let freezeArguments: boolean | undefined;
	if (Object.hasOwn(data, "freezeArguments")) {
		if (typeof data.freezeArguments !== "boolean") return { ok: false, error: `"freezeArguments" must be true or false` };
		freezeArguments = data.freezeArguments;
	}
	const extra = freezeArguments === undefined ? {} : { freezeArguments };
	if (data.defaults === undefined) return { ok: true, defaults: {}, ...extra };
	if (!isRecord(data.defaults)) return { ok: false, error: `"defaults" must be an object` };
	const defaults: Partial<Record<ConfigurableSource, SourceDefault>> = {};
	for (const [key, value] of Object.entries(data.defaults)) {
		if (!(SOURCES as readonly string[]).includes(key)) return { ok: false, error: `unknown source "${key}" in "defaults"` };
		if (typeof value !== "string" || !Object.hasOwn(RANK, value)) return { ok: false, error: `"defaults.${key}" must be allow, hints, ask or never` };
		defaults[key as ConfigurableSource] = value as SourceDefault;
	}
	return { ok: true, defaults, ...extra };
}

export interface FreezeSetting {
	enabled: boolean;
	/** Why, in words for the status command. */
	reason: string;
}

/**
 * Whether a call's arguments are frozen once the guard lets the call through. On unless the
 * global file turns it off. A project file can only turn it on: a cloned repo must not be able to
 * switch the protection off. A broken file in either place keeps it on.
 */
export function resolveFreeze(global?: ParsedConfig, project?: ParsedConfig): FreezeSetting {
	if ((global && !global.ok) || (project && !project.ok)) return { enabled: true, reason: "a config file is broken, so the safe setting applies" };
	if (project?.ok && project.freezeArguments === true) return { enabled: true, reason: "the project file turns it on" };
	const ignored = project?.ok && project.freezeArguments === false ? " (the project file's false is ignored: a project can only turn it on)" : "";
	if (global?.ok && global.freezeArguments === false) return { enabled: false, reason: `the global file turns it off${ignored}` };
	if (global?.ok && global.freezeArguments === true) return { enabled: true, reason: `the global file turns it on${ignored}` };
	return { enabled: true, reason: `the default${ignored}` };
}

/**
 * The effective source defaults. The global file sets them; the project file can only tighten.
 * An unreadable or invalid file (either one) makes every source at least `ask`.
 * `undefined` means the file does not exist.
 */
export function resolveDefaults(global?: ParsedConfig, project?: ParsedConfig): Record<ConfigurableSource, SourceDefault> {
	const out = { ...SHIPPED_DEFAULTS };
	const broken = (global && !global.ok) || (project && !project.ok);
	for (const source of SOURCES) {
		if (global?.ok && global.defaults[source]) out[source] = global.defaults[source]!;
		if (project?.ok && project.defaults[source]) out[source] = stricterDefault(out[source], project.defaults[source]!);
		if (broken) out[source] = stricterDefault(out[source], "ask");
	}
	return out;
}

// ---- rules -----------------------------------------------------------------------------------

/** Every field a rule may have. Anything else is rejected, because it is almost always a typo. */
export const RULE_FIELDS: ReadonlySet<string> = new Set(["tool", "args", "when", "verdict", "reason", "title", "preview", "windowMs", "trustedParents"]);

/**
 * Reject a field a rule does not have. A typo such as `arg` for `args`, or `whn` for `when`, would
 * otherwise register without complaint and leave the narrowing out, so an `allow` rule written to
 * cover one path would cover every call to the tool. Symbol keys are rejected too.
 */
function rejectUnknownFields(rule: object): void {
	// Own keys and keys on the prototype chain: snapshotRule reads fields by name, so a rule built on
	// a prototype works, and an unknown name there is just as likely to be a typo. Object.prototype
	// is left out (its members are on every object and cannot be a rule author's typo).
	const keys = new Set<string | symbol>();
	for (let o: object | null = rule; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const key of Reflect.ownKeys(o)) keys.add(key);
	const unknown = [...keys].filter((key) => typeof key !== "string" || !RULE_FIELDS.has(key));
	if (unknown.length === 0) return;
	const names = unknown.map((key) => (typeof key === "string" ? `"${key.length > 40 ? `${key.slice(0, 40)}...` : key}"` : "a symbol key")).join(", ");
	throw new TypeError(`rule has no field ${names}; the fields are ${[...RULE_FIELDS].join(", ")}`);
}

/**
 * A frozen copy of a rule, validated. Every property is read once, so a rule built with getters
 * cannot pass validation and then change; later edits to the original do not reach the copy. The
 * guard and the registering package's fallback both use the copy. A field a rule does not have is
 * an error (see `rejectUnknownFields`).
 */
export function snapshotRule(rule: Rule): Rule {
	if (!isRecord(rule)) throw new TypeError("rule must be an object");
	rejectUnknownFields(rule);
	const { tool, args, when, verdict, reason, title, preview, windowMs, trustedParents } = rule;
	const copy: Record<string, unknown> = {
		tool: isRecord(tool) ? Object.freeze({ server: tool.server, tool: tool.tool }) : tool,
		verdict,
	};
	if (args !== undefined) copy.args = isRecord(args) ? Object.freeze({ ...args }) : args;
	if (when !== undefined) copy.when = when;
	if (reason !== undefined) copy.reason = reason;
	if (title !== undefined) copy.title = title;
	if (preview !== undefined) copy.preview = preview;
	if (windowMs !== undefined) copy.windowMs = windowMs;
	if (trustedParents !== undefined) copy.trustedParents = Array.isArray(trustedParents) ? Object.freeze([...trustedParents]) : trustedParents;
	validateRule(copy as unknown as Rule);
	return Object.freeze(copy) as unknown as Rule;
}

/** Throws on a rule the layer cannot apply safely, including one with a field it does not have. Called at registration. */
export function validateRule(rule: Rule): void {
	if (!isRecord(rule)) throw new TypeError("rule must be an object");
	rejectUnknownFields(rule);
	if (typeof rule.verdict !== "string" || !Object.hasOwn(VERDICT_RANK, rule.verdict)) {
		throw new TypeError(`rule verdict must be allow, ask or never, got ${String(rule.verdict)}`);
	}
	const { tool } = rule;
	if (typeof tool === "string") {
		if (tool.length === 0) throw new TypeError("rule tool must not be empty");
	} else if (!isRecord(tool) || typeof tool.server !== "string" || typeof tool.tool !== "string" || !tool.server || !tool.tool) {
		throw new TypeError("rule tool must be a name, a pattern, or { server, tool } with non-empty strings");
	}
	if (rule.args !== undefined) {
		if (!isRecord(rule.args)) throw new TypeError("rule args must be an object");
		for (const [key, value] of Object.entries(rule.args)) {
			if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
				throw new TypeError(`rule args.${key} must be a string, number, boolean or null`);
			}
		}
	}
	if (rule.verdict !== "ask" && (rule.preview !== undefined || rule.windowMs !== undefined || rule.trustedParents !== undefined)) {
		throw new TypeError("preview, windowMs and trustedParents apply only to ask rules");
	}
	if (rule.when !== undefined && typeof rule.when !== "function") throw new TypeError("rule when must be a function");
	if (rule.reason !== undefined) {
		if (rule.verdict !== "never") throw new TypeError("reason applies only to never rules");
		checkText("reason", rule.reason, MAX_REASON_CHARS);
	}
	if (rule.title !== undefined) {
		if (rule.verdict !== "ask") throw new TypeError("title applies only to ask rules");
		checkText("title", rule.title, MAX_TITLE_CHARS);
	}
	if (rule.preview !== undefined && typeof rule.preview !== "function") throw new TypeError("rule preview must be a function");
	if (rule.windowMs !== undefined && !(Number.isFinite(rule.windowMs) && rule.windowMs > 0)) {
		throw new TypeError("rule windowMs must be a positive number");
	}
	if (rule.trustedParents !== undefined && (!Array.isArray(rule.trustedParents) || rule.trustedParents.some((p) => typeof p !== "string" || !p))) {
		throw new TypeError("rule trustedParents must be a list of tool names");
	}
}

function checkText(field: string, value: unknown, max: number): void {
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`rule ${field} must be a non-empty string`);
	if (value.length > max) throw new TypeError(`rule ${field} must be at most ${max} characters, got ${value.length}`);
}

/** Exact, case-sensitive match where `*` is the only wildcard. */
export function matchPattern(pattern: string, name: string): boolean {
	if (!pattern.includes("*")) return pattern === name;
	const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return new RegExp(`^${source}$`, "s").test(name);
}

/**
 * Whether a rule's argument narrowing (`args` and `when`, both must hold) applies. Input that is
 * not a plain object cannot be checked, so it counts as a match for `ask` and `never` rules
 * (stricter) and as no match for `allow`, and `when` is not called for it.
 */
function argsMatch(rule: Rule, input: unknown): boolean {
	const want = rule.args;
	if (!want && rule.when === undefined) return true;
	if (!isRecord(input)) return rule.verdict !== "allow";
	if (want && !Object.entries(want).every(([key, value]) => Object.hasOwn(input, key) && input[key] === value)) return false;
	return rule.when === undefined || predicateMatches(rule, input);
}

/**
 * Run a rule's `when`. Only a strict `true` or `false` is an answer. A throw or anything else
 * (a Promise, undefined, a truthy value) is unusable, and that counts as a match unless the rule
 * is `allow`, so a broken predicate can only make a rule stricter.
 */
function predicateMatches(rule: Rule, input: unknown): boolean {
	const unusable = rule.verdict !== "allow";
	let result: unknown;
	try {
		result = rule.when!(input);
	} catch {
		return unusable;
	}
	if (result === true) return true;
	if (result === false) return false;
	// An async predicate's rejection must not surface as an unhandled rejection.
	if (result instanceof Promise) result.catch(() => undefined);
	return unusable;
}

/**
 * Whether a rule names this call's tool.
 *
 * A `{ server, tool }` rule matches the suffixed name always (the hash is unique to that pair) and
 * the plain name only when the live tool belongs to that server. When the owner is unknown, only
 * `ask` and `never` rules match: applying them is stricter, applying an `allow` would loosen.
 */
export function ruleNamesTool(rule: Rule, name: string, tool: LiveTool | undefined): boolean {
	if (typeof rule.tool === "string") {
		if (matchPattern(rule.tool, name)) return true;
		// The suffix-stripped form only widens ask and never rules: for an allow rule it could name a
		// different tool whose real name happens to end in `_<8 hex>`.
		return rule.verdict !== "allow" && matchPattern(rule.tool, stripHashSuffix(name));
	}
	const { plain, suffixed } = computeMcpToolNames(rule.tool.server, rule.tool.tool);
	if (name === suffixed) return true;
	if (name !== plain) return false;
	const owner = tool?.namespace?.name;
	if (owner === undefined) return rule.verdict !== "allow";
	return owner === mcpNamespace(rule.tool.server);
}

export interface Call {
	name: string;
	input: unknown;
}

/** Whether a rule applies to this call: it names the tool and its argument narrowing fits. */
export function ruleApplies(rule: Rule, call: Call, tool: LiveTool | undefined): boolean {
	return ruleNamesTool(rule, call.name, tool) && argsMatch(rule, call.input);
}

export interface Decision {
	verdict: Verdict;
	source: ToolSource;
	/** The rules that decided it, strictest first. Empty when a source default decided. */
	rules: Rule[];
	/** Why, in words for the status command and block reasons. */
	why: string;
}

/**
 * The verdict for one call. Matching rules decide, and the strictest of them wins. With no
 * matching rule, the source default decides; `hints` passes only a declared `readOnlyHint` true.
 * A tool the live list does not show always asks unless a rule says `never`.
 */
export function decide(call: Call, tool: LiveTool | undefined, rules: readonly Rule[], defaults: Record<ConfigurableSource, SourceDefault>): Decision {
	const source = classify(call.name, tool);
	const matched = rules.filter((rule) => ruleApplies(rule, call, tool));
	if (source === "unknown") {
		const never = matched.filter((r) => r.verdict === "never");
		if (never.length) return { verdict: "never", source, rules: never, why: "a rule never allows it" };
		return { verdict: "ask", source, rules: matched.filter((r) => r.verdict === "ask"), why: "the tool is not in pi's tool list" };
	}
	if (matched.length) {
		const verdict = matched.map((r) => r.verdict).reduce(stricterVerdict);
		const deciding = matched.filter((r) => r.verdict === verdict);
		return { verdict, source, rules: deciding, why: `${deciding.length > 1 ? "rules" : "a rule"} for ${call.name}` };
	}
	const fallback = defaults[source];
	if (typeof fallback !== "string" || !Object.hasOwn(RANK, fallback)) {
		return { verdict: "ask", source, rules: [], why: `the default for ${source} tools is not valid` };
	}
	if (fallback !== "hints") return { verdict: fallback as Verdict, source, rules: [], why: `the default for ${source} tools is ${fallback}` };
	if (tool?.annotations?.readOnlyHint === true) return { verdict: "allow", source, rules: [], why: "the tool declares readOnlyHint" };
	return { verdict: "ask", source, rules: [], why: "the tool does not declare readOnlyHint" };
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
