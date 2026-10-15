/**
 * pi-governor's pure pieces: rules, names and the decision function. The host extension is
 * host.ts; packages that register rules import the client (client.ts, "pi-governor/client").
 * See docs/design.md.
 */

export { computeMcpToolNames, MAX_TOOL_NAME_LENGTH, plainMcpToolName, stripHashSuffix, suffixedMcpToolName } from "./names.ts";
export type { McpToolNames } from "./names.ts";
export {
	BUILTIN_TOOLS,
	classify,
	decide,
	matchPattern,
	mcpNamespace,
	parseConfig,
	resolveDefaults,
	ruleApplies,
	ruleNamesTool,
	SHIPPED_DEFAULTS,
	snapshotRule,
	SOURCES,
	stricterDefault,
	validateRule,
} from "./rules.ts";
export type { ArgValue, Call, ConfigurableSource, Decision, LiveTool, ParsedConfig, Rule, SourceDefault, ToolSource, Verdict } from "./rules.ts";
