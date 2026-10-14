/**
 * The text of `/governor`: what is live, said plainly. Pure; host.ts feeds it.
 *
 * Each line says what is known and what is not. A status that reported children as covered, or
 * the handler order as safe, without knowing would be worse than none: the user stops watching.
 */

import type { ApprovalInfo } from "./guard.ts";
import { formatDuration } from "./dialog.ts";
import type { HostPack } from "./registry.ts";
import { clipVisible, visible } from "./sanitize.ts";
import { type ConfigurableSource, type LiveTool, type ParsedConfig, type Rule, ruleNamesTool, SOURCES, type SourceDefault } from "./rules.ts";

export interface ConfigState {
	path: string;
	/** undefined: the file does not exist. */
	parsed: ParsedConfig | undefined;
}

export interface StatusInput {
	hostCount: number;
	/** This session has a governor handler of its own. */
	covered: boolean;
	/** Registrations a host has not taken (another API version, or a refused entry). */
	pending: number;
	packs: readonly HostPack[];
	tools: readonly LiveTool[];
	config: { global: ConfigState; project: ConfigState } | undefined;
	defaults: Record<ConfigurableSource, SourceDefault>;
	approvals: readonly ApprovalInfo[];
	now: number;
}

const MAX_LISTED = 12;

function describeRule(rule: Rule): string {
	const tool = typeof rule.tool === "string" ? rule.tool : `${rule.tool.server} / ${rule.tool.tool}`;
	const parts = [`${rule.verdict.padEnd(5)} ${clipVisible(tool, 80).text}`];
	if (rule.args) parts.push(`when ${Object.keys(rule.args).map((k) => clipVisible(k, 30).text).join(", ")} match`);
	if (rule.windowMs !== undefined) parts.push(`window ${formatDuration(rule.windowMs)}`);
	if (rule.trustedParents?.length) parts.push(`trusts ${rule.trustedParents.map((p) => clipVisible(p, 30).text).join(", ")}`);
	return parts.join(", ");
}

function configLine(label: string, state: ConfigState): string {
	const path = visible(state.path);
	if (state.parsed === undefined) return `  ${label}: ${path} (not present)`;
	if (!state.parsed.ok) return `  ${label}: ${path} IS BROKEN (${visible(state.parsed.error)}); every source asks until it is fixed`;
	const set = Object.entries(state.parsed.defaults).map(([k, v]) => `${k}=${v}`);
	return `  ${label}: ${path} (${set.length ? set.join(", ") : "no defaults set"})`;
}

export function buildStatus(input: StatusInput): string {
	const lines: string[] = ["pi-governor"];

	lines.push("", "Host");
	lines.push(`  ${input.hostCount} host${input.hostCount === 1 ? "" : "s"} loaded in this process.`);
	lines.push(
		input.covered
			? "  This session has a governor handler: calls are checked."
			: "  This session has NO governor handler of its own. Packages here apply their own whenNoHost choice, and rules from other packages are not enforced.",
	);
	if (input.pending > 0) lines.push(`  ${input.pending} registration${input.pending === 1 ? " is" : "s are"} waiting for a host they can use (another API version, or one that was refused).`);

	lines.push("", "Source defaults (for tools no rule names)");
	for (const source of SOURCES) lines.push(`  ${source}: ${input.defaults[source]}`);
	lines.push("  unknown (not in pi's tool list): ask");
	if (input.config) {
		lines.push(configLine("global file", input.config.global), configLine("project file", input.config.project));
	} else {
		lines.push("  The config files have not been read yet (no session_start); the shipped defaults apply.");
	}

	lines.push("", `Rule packs (${input.packs.length})`);
	if (input.packs.length === 0) lines.push("  None registered. Only the source defaults apply.");
	for (const pack of input.packs) {
		lines.push(`  ${clipVisible(pack.id, 80).text}: ${pack.rules.length} rule${pack.rules.length === 1 ? "" : "s"}`);
		for (const rule of pack.rules.slice(0, MAX_LISTED)) lines.push(`    ${describeRule(rule)}`);
		if (pack.rules.length > MAX_LISTED) lines.push(`    ... and ${pack.rules.length - MAX_LISTED} more`);
	}

	const mcpListed = input.tools.some((t) => t.name.startsWith("mcp__") || t.namespace?.name.startsWith("mcp__"));
	const unmatched: string[] = [];
	for (const pack of input.packs) {
		for (const rule of pack.rules) {
			if (!input.tools.some((tool) => ruleNamesTool(rule, tool.name, tool))) unmatched.push(`${clipVisible(pack.id, 40).text}: ${describeRule(rule)}`);
		}
	}
	lines.push("", "Rules that match no live tool");
	if (unmatched.length === 0) lines.push("  None.");
	else {
		for (const u of unmatched.slice(0, MAX_LISTED)) lines.push(`  ${u}`);
		if (unmatched.length > MAX_LISTED) lines.push(`  ... and ${unmatched.length - MAX_LISTED} more`);
		lines.push(
			mcpListed
				? "  A rule that names a tool pi has not registered protects nothing yet. Check the server and tool names, or that the server is connected."
				: "  No MCP tools are listed yet. Servers connect in the background, so these may match once they have.",
		);
	}

	lines.push("", "Approvals");
	if (input.approvals.length === 0) lines.push("  None live. Every ask rule asks each time.");
	for (const a of input.approvals) lines.push(`  ${clipVisible(a.tool, 80).text}: ${formatDuration(Math.max(a.expiresAt - input.now, 0))} left`);

	lines.push("", "Not covered, or not known");
	lines.push("  Subagent children: not known. A child is covered only if its host loads this extension into it, and this package cannot see how that host does it. Treat children as not covered unless you set that up. A child with no UI blocks every ask call.");
	lines.push("  Handler order: measured on pi 1.2.0. pi runs tool_call handlers in load order. A handler loaded AFTER this one can change a call's arguments in place once they were checked, and the tool then receives the changed arguments; a handler loaded before it is safe, because this extension sees its changes. This package cannot control load order.");
	lines.push("  Not gated: pi's own process, other extensions' code, and MCP servers, which run with your permissions. For real isolation, run pi in a container.");

	return lines.join("\n");
}
