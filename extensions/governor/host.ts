/**
 * The guard host: the extension pi loads. It publishes the registry, reads governor.json, and
 * installs the `tool_call` handler that runs Guard for every call, nested calls included.
 *
 * pi runs `tool_call` handlers one after the other in load order, and a handler that runs later
 * could change `event.input` in place after the guard has decided (measured on pi 1.1.0 and 1.2.0;
 * see docs/design.md, "Care needed"). So the guard freezes the arguments of every call before it
 * checks it (freeze.ts), unless `freezeArguments` is turned off in governor.json.
 */

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ChildCoverage, hookSpecifiers, hostModulePath, loadRequiredChildHook, registerForChildren, type RequiredChildHook } from "./children.ts";
import { type ConfigSource, globalConfigPath, projectConfigPath, readConfig } from "./config.ts";
import { Guard } from "./guard.ts";
import { hostCount, isCovered, livePacks, markCovered, pendingCount, publishHost } from "./registry.ts";
import { resolveDefaults, resolveFreeze } from "./rules.ts";
import { clipVisible, visible } from "./sanitize.ts";
import { buildStatus } from "./status.ts";

let hostCounter = 0;

export interface HostOptions {
	/** How pi-subagents' required-child hook is found. Tests pass their own. */
	loadChildHook?: (specifiers: string[]) => Promise<RequiredChildHook | undefined>;
}

export default function governorHost(pi: ExtensionAPI): void {
	createGovernorHost(pi);
}

export function createGovernorHost(pi: ExtensionAPI, options: HostOptions = {}): void {
	const loadChildHook = options.loadChildHook ?? loadRequiredChildHook;
	let children: ChildCoverage = { state: "pending" };
	let childRegistration: { dispose(): void } | undefined;
	const dropChildRegistration = (): void => {
		try {
			childRegistration?.dispose();
		} catch {
			// already gone
		}
		childRegistration = undefined;
	};
	const hostId = `host-${process.pid}-${++hostCounter}-${Date.now().toString(36)}`;
	const unpublish = publishHost(hostId);

	let config: { global: ConfigSource; project: ConfigSource } | undefined;
	const guard = new Guard({
		packs: livePacks,
		tools: () => pi.getAllTools(),
		// Until session_start has read the files, the shipped defaults apply.
		defaults: () => resolveDefaults(config?.global.parsed, config?.project.parsed),
		freezeArguments: () => resolveFreeze(config?.global.parsed, config?.project.parsed).enabled,
	});

	pi.on("session_start", async (_event, ctx) => {
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

		// Make every native subagent child of this session load this host (children.ts).
		dropChildRegistration();
		try {
			// Find pi-subagents where this process loaded it (from its tools' source), before guessing.
			const hook = await loadChildHook(hookSpecifiers(pi.getAllTools()));
			if (!hook) {
				children = { state: "absent" };
				return;
			}
			childRegistration = registerForChildren(hook, ctx.sessionManager.getSessionId(), hostModulePath(import.meta.url));
			children = { state: "registered" };
		} catch (error) {
			children = { state: "failed", error: error instanceof Error ? error.message : String(error) };
		}
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
	pi.registerCommand("governor", {
		description: "Show pi-governor's live rules, defaults, approvals and what it does not cover; \"revoke\" drops every live approval",
		handler: async (args, ctx) => {
			const argument = typeof args === "string" ? args.trim() : "";
			if (argument === "revoke") {
				const dropped = guard.approvals().length;
				guard.clearApprovals();
				ctx.ui.notify(dropped === 0 ? "pi-governor: no live approvals to revoke." : `pi-governor: revoked ${dropped} live approval${dropped === 1 ? "" : "s"}. The next matching call asks again.`, "info");
				return;
			}
			if (argument !== "") {
				ctx.ui.notify(`pi-governor: unknown argument "${visible(clipVisible(argument, 40).text)}". Usage: /governor (status) or /governor revoke (drop every live approval).`, "warning");
				return;
			}
			let text: string;
			try {
				text = buildStatus({
					hostCount: hostCount(),
					covered: isCovered(ctx.sessionManager),
					pending: pendingCount(),
					packs: livePacks(),
					tools: pi.getAllTools(),
					config,
					defaults: resolveDefaults(config?.global.parsed, config?.project.parsed),
					freeze: resolveFreeze(config?.global.parsed, config?.project.parsed),
					children,
					approvals: guard.approvals(),
					now: Date.now(),
				});
			} catch (error) {
				text = `pi-governor could not build its status: ${error instanceof Error ? error.message : String(error)}`;
			}
			ctx.ui.notify(text, "info");
		},
	});
	pi.on("session_shutdown", () => {
		dropChildRegistration();
		children = { state: "pending" };
		unpublish();
	});
}
