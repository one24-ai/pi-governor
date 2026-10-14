/**
 * The guard host: the extension pi loads. It publishes the registry, reads governor.json, and
 * installs the `tool_call` handler that runs Guard for every call, nested calls included.
 *
 * Install this handler first in load order where possible: pi runs `tool_call` handlers one
 * after the other in load order, and a handler that runs later can still change `event.input` in
 * place after the guard has decided (read from pi 1.1.0's source, not measured; see
 * docs/design.md, "Care needed").
 */

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ConfigSource, globalConfigPath, projectConfigPath, readConfig } from "./config.ts";
import { Guard } from "./guard.ts";
import { livePacks, markCovered, publishHost } from "./registry.ts";
import { resolveDefaults } from "./rules.ts";

let hostCounter = 0;

export default function governorHost(pi: ExtensionAPI): void {
	const hostId = `host-${process.pid}-${++hostCounter}-${Date.now().toString(36)}`;
	const unpublish = publishHost(hostId);

	let config: { global: ConfigSource; project: ConfigSource } | undefined;
	const guard = new Guard({
		packs: livePacks,
		tools: () => pi.getAllTools(),
		// Until session_start has read the files, the shipped defaults apply.
		defaults: () => resolveDefaults(config?.global.parsed, config?.project.parsed),
	});

	pi.on("session_start", (_event, ctx) => {
		try {
			config = { global: readConfig(globalConfigPath(getAgentDir())), project: readConfig(projectConfigPath(ctx.cwd)) };
		} catch (error) {
			// Reading failed outright: treat both files as broken, so every source asks.
			const broken = { path: "", parsed: { ok: false as const, error: `could not be read: ${error instanceof Error ? error.message : String(error)}` } };
			config = { global: broken, project: broken };
		}
		guard.clearApprovals();
		// Tells the registering packages that this session has a host handler of its own.
		markCovered(ctx.sessionManager);
	});
	pi.on("tool_execution_start", (event) => guard.noteStart(event.toolCallId, event.toolName));
	pi.on("tool_execution_end", (event) => guard.noteEnd(event.toolCallId));
	pi.on("tool_call", (event, ctx) =>
		guard.check(
			{
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
				input: event.input,
			},
			ctx,
		),
	);
	pi.on("session_shutdown", () => unpublish());
}
