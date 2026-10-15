/**
 * Text that reaches a dialog or a block reason. Tool arguments, tool names and rule previews can
 * be steered by anything the model has read, so they must not reach a terminal as they are: an
 * escape sequence can write to the clipboard, set the window title or overdraw other rows, and a
 * bidi control can reorder what the reader sees.
 *
 * Nothing is dropped silently. Each control, format or invisible character becomes a visible
 * `<U+XXXX>` marker, so the dialog shows what is sent instead of a tidied version of it. An
 * escape sequence ends up as its marker followed by its printable remainder, which does nothing.
 */

/**
 * Characters that act on a terminal or hide content: C0 controls except tab and newline, DEL and
 * C1, soft hyphen, combining grapheme joiner, Hangul and Braille fillers, Mongolian and variation
 * selectors, zero-width and bidi controls, line and paragraph separators, invisible operators,
 * BOM and interlinear marks, tag characters, supplementary variation selectors, musical
 * invisibles, and any lone surrogate. Matched by code point (`u` flag), so a valid surrogate pair
 * counts as one character and only a lone half matches the surrogate range.
 */
const NEEDS_MARKER =
	/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\ud800-\udfff\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

const marker = (char: string): string => `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`;

/**
 * `text` with every character that could act on a terminal or hide content replaced by a marker.
 * With `keepBreaks`, newlines and tabs stay (a lone carriage return does not: it overwrites a
 * line) and CRLF counts as one newline; otherwise they become markers too, for one-line text.
 */
export function visible(text: unknown, keepBreaks = false): string {
	let s = typeof text === "string" ? text : String(text);
	if (keepBreaks) s = s.replace(/\r\n/g, "\n");
	else s = s.replace(/[\t\n]/g, marker);
	return s.replace(NEEDS_MARKER, marker);
}

export interface Clipped {
	/** The kept part, made visible. */
	text: string;
	/** Length of the original in UTF-16 code units. */
	total: number;
	clipped: boolean;
}

/** The first `max` code units of `text` (never half a surrogate pair), made visible, with the original length. */
export function clipVisible(text: string, max: number, keepBreaks = false): Clipped {
	const total = text.length;
	if (total <= max) return { text: visible(text, keepBreaks), total, clipped: false };
	let end = max;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return { text: visible(text.slice(0, end), keepBreaks), total, clipped: true };
}
