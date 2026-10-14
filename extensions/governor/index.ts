/**
 * pi-governor's public entry point. Rules, the registry and the guard host land here as they
 * are built; see docs/design.md.
 */

export { computeMcpToolNames, MAX_TOOL_NAME_LENGTH, plainMcpToolName, stripHashSuffix, suffixedMcpToolName } from "./names.ts";
export type { McpToolNames } from "./names.ts";
export {
	classify,
	decide,
	matchPattern,
	mcpNamespace,
	parseConfig,
	resolveDefaults,
	ruleNamesTool,
	SHIPPED_DEFAULTS,
	BUILTIN_TOOLS,
	SOURCES,
	stricterDefault,
	validateRule,
} from "./rules.ts";
export type { ArgValue, Call, ConfigurableSource, Decision, LiveTool, ParsedConfig, Rule, SourceDefault, ToolSource, Verdict } from "./rules.ts";
