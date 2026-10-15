/**
 * The text of an approval dialog. Pure: it builds a title and a message from the call, the
 * decision and the rules that decided it.
 *
 * A preview must never hide what is actually sent (docs/design.md, "Care needed"). So:
 * - a rule's own `preview(args)` is shown, but every top-level argument whose value is not in the
 *   text the user sees is listed after it ("Not shown in the preview above");
 * - without a preview, or when it fails, every argument is shown as `key: value`, each value
 *   clipped with its full length stated;
 * - everything goes through `visible()`, so control and invisible characters show as markers.
 */

import { type Decision, MAX_TITLE_CHARS, type Rule } from "./rules.ts";
import { clipVisible, visible } from "./sanitize.ts";

/** Characters of one argument value in the default view. */
export const MAX_VALUE_CHARS = 300;
/** Arguments listed in the default view. */
export const MAX_FIELDS = 20;
/** Characters of the whole preview body. */
export const MAX_BODY_CHARS = 3000;
const MAX_KEY_CHARS = 60;
const MAX_HIDDEN_LISTED = 10;

export interface Dialog {
	title: string;
	message: string;
}

export interface DialogInput {
	toolName: string;
	input: unknown;
	decision: Decision;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** "15 minutes", "90 seconds", "1 hour". */
export function formatDuration(ms: number): string {
	const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 120) return plural(Math.max(seconds, 1), "second");
	const minutes = Math.round(seconds / 60);
	if (minutes < 120) return plural(minutes, "minute");
	return plural(Math.round(minutes / 60), "hour");
}

/** The shortest approval window among the deciding rules, or undefined when any of them asks every time. */
export function effectiveWindowMs(rules: readonly Rule[]): number | undefined {
	if (rules.length === 0 || rules.some((r) => r.windowMs === undefined)) return undefined;
	return Math.min(...rules.map((r) => r.windowMs!));
}

function valueText(value: unknown): { text: string; unprintable: boolean } {
	if (typeof value === "string") return { text: value, unprintable: false };
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return { text: json, unprintable: false };
	} catch {
		// circular, BigInt, throwing toJSON
	}
	return { text: `(could not be shown: ${typeof value})`, unprintable: true };
}

/** A continuation line is indented so a value cannot pass a line of its own off as another argument. */
const indentBreaks = (text: string): string => text.replace(/\n/g, "\n  ");

/** Every argument as `key: value`. Throws only if the input cannot be shown at all. */
export function renderArguments(input: unknown): string {
	if (!isRecord(input)) {
		const { text } = valueText(input);
		const clipped = clipVisible(text, MAX_VALUE_CHARS, true);
		return `Arguments: ${indentBreaks(clipped.text)}${clipped.clipped ? disclosure(clipped.total) : ""}`;
	}
	const keys = Object.keys(input);
	if (keys.length === 0) return "(no arguments)";
	const lines = keys.slice(0, MAX_FIELDS).map((key) => {
		const k = clipVisible(key, MAX_KEY_CHARS);
		const v = clipVisible(valueText(input[key]).text, MAX_VALUE_CHARS, true);
		return `${k.text}${k.clipped ? `... (name is ${k.total} characters)` : ""}: ${indentBreaks(v.text)}${v.clipped ? disclosure(v.total) : ""}`;
	});
	if (keys.length > MAX_FIELDS) lines.push(`... and ${keys.length - MAX_FIELDS} more arguments not shown`);
	return lines.join("\n");
}

const disclosure = (total: number): string => ` [... ${total} characters in total, first ${MAX_VALUE_CHARS} shown]`;

/** A value shorter than this counts as shown only when the preview also names its argument. */
const MIN_STANDALONE_CHARS = 8;

/**
 * The top-level arguments the preview does not demonstrably show, described without their value:
 * `name (120 characters)`.
 *
 * A short or generic value ("true", "a", "5") appears in almost any text by chance, and the model
 * controls other arguments that feed the preview, so a bare substring match proves nothing. A
 * value counts as shown when it is at least 8 characters and appears in the preview, or when the
 * preview names the argument and also contains the value. An empty value is shown only when the
 * preview names its argument. An argument the preview is not clear about is listed, which costs
 * a line of noise and never hides anything.
 */
export function hiddenArguments(input: unknown, shown: string): string[] {
	if (!isRecord(input)) return [];
	const out: string[] = [];
	for (const key of Object.keys(input)) {
		const value = input[key];
		const { text, unprintable } = valueText(value);
		const needle = typeof value === "string" ? visible(value, true) : text;
		const named = shown.includes(visible(key));
		const contains = needle.length > 0 && shown.includes(needle);
		const isShown = !unprintable && ((needle.length >= MIN_STANDALONE_CHARS && contains) || (named && (contains || needle.length === 0)));
		if (isShown) continue;
		const label = typeof value === "string" ? `${value.length} characters` : Array.isArray(value) ? "list" : typeof value === "object" && value !== null ? "object" : typeof value;
		out.push(`${clipVisible(key, MAX_KEY_CHARS).text} (${label})`);
	}
	return out;
}

function callPreview(rule: Rule, input: unknown): string | undefined {
	if (!rule.preview) return undefined;
	try {
		const text = rule.preview(structuredClone(input));
		return typeof text === "string" ? text : undefined;
	} catch {
		return undefined;
	}
}

export function buildDialog({ toolName, input, decision }: DialogInput): Dialog {
	const name = clipVisible(toolName, 100);
	const withPreview = decision.rules.filter((r) => r.preview);
	const previews = withPreview.map((r) => callPreview(r, input));
	const previewFailed = previews.some((p) => p === undefined);
	const custom = [...new Set(previews.filter((p): p is string => p !== undefined))];

	let body: string;
	const notes: string[] = [];
	if (custom.length > 0 && !previewFailed) {
		body = custom.map((p) => visible(p, true)).join("\n\n");
	} else {
		body = renderArguments(input);
		if (previewFailed) notes.push("A rule's own preview failed, so the arguments are shown as they are.");
	}

	const total = body.length;
	let shown = body;
	if (total > MAX_BODY_CHARS) {
		shown = clipVisible(body, MAX_BODY_CHARS, true).text;
		notes.push(`Shortened: the first ${MAX_BODY_CHARS} of ${total} characters are shown.`);
	}
	if (custom.length > 0 && !previewFailed) {
		const hidden = hiddenArguments(input, shown);
		if (hidden.length > 0) {
			const listed = hidden.slice(0, MAX_HIDDEN_LISTED).join(", ");
			const more = hidden.length > MAX_HIDDEN_LISTED ? `, and ${hidden.length - MAX_HIDDEN_LISTED} more` : "";
			notes.push(`Not shown in the preview above: ${listed}${more}.`);
		}
	}
	notes.push(`Why you are asked: ${clipVisible(decision.why, 200).text}.`);
	const window = effectiveWindowMs(decision.rules);
	if (window !== undefined) notes.push(`If you allow this, ${name.text} also runs without asking for the next ${formatDuration(window)}.`);

	const ruleTitle = decision.rules.find((r) => typeof r.title === "string" && r.title.length > 0)?.title;
	return {
		title: ruleTitle === undefined ? `Allow ${name.text}${name.clipped ? "..." : ""}?` : clipVisible(ruleTitle, MAX_TITLE_CHARS).text,
		message: `${shown}\n\n${notes.join("\n")}`,
	};
}
