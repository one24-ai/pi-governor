/**
 * pi-containment's public entry point. Rules, the registry and the guard host land here as they
 * are built; see docs/design.md.
 */

export { computeMcpToolNames, MAX_TOOL_NAME_LENGTH, plainMcpToolName, stripHashSuffix, suffixedMcpToolName } from "./names.ts";
export type { McpToolNames } from "./names.ts";
