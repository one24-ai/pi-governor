/**
 * The names pi registers for MCP tools.
 *
 * This copies pi 1.1's `createMcpToolName` (dist/extensions/mcp/tools.js), which is not a public
 * API. test/names.test.ts checks it against pi's own function, so a pi update that changes the
 * algorithm fails the tests instead of silently letting a write tool slip past a rule.
 *
 * A name is a candidate, not an answer: whether pi suffixes it depends on collisions with other
 * tools, which are only known once servers connect. See "Match on the name pi registers" in
 * docs/design.md.
 */

import { createHash } from "node:crypto";

/** Longest tool name pi registers before it cuts and suffixes. */
export const MAX_TOOL_NAME_LENGTH = 64;

const SUFFIX = /_[0-9a-f]{8}$/;

/** `mcp__<server>__<tool>` with every character outside `[A-Za-z0-9_]` replaced by `_`. */
export function plainMcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/** The plain name cut to fit, plus `_` and 8 hex characters of SHA-256 over `<server>\0<tool>`. */
export function suffixedMcpToolName(server: string, tool: string): string {
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${plainMcpToolName(server, tool).slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

export interface McpToolNames {
	/** The unsuffixed name, or undefined when it is too long for pi to ever register. */
	plain: string | undefined;
	/** The suffixed name pi uses when the plain one is too long or taken. */
	suffixed: string;
}

/** Every name pi could register for this server and tool. */
export function computeMcpToolNames(server: string, tool: string): McpToolNames {
	const plain = plainMcpToolName(server, tool);
	return {
		plain: plain.length <= MAX_TOOL_NAME_LENGTH ? plain : undefined,
		suffixed: suffixedMcpToolName(server, tool),
	};
}

/** The name with a trailing `_<8 hex>` removed, for matching `*` patterns written without one. */
export function stripHashSuffix(name: string): string {
	return name.replace(SUFFIX, "");
}
