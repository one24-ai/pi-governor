/**
 * The client packages use to register rules with pi-governor:
 *
 *     import { registerRules } from "pi-governor/client";
 *
 *     registerRules(pi, {
 *         id: "my-pack",
 *         rules: [{ tool: { server: "tracker", tool: "create_issue" }, verdict: "ask" }],
 *         whenNoHost: "block",
 *     });
 *
 * It never loads the host. It only looks for it on globalThis (see registry.ts), so it works
 * whichever extension loads first and without pi-governor installed:
 *
 * - host already loaded: the rules are registered with it straight away.
 * - host loads later: the registration is queued and the host takes it over when it loads.
 * - no host (not loaded, an API version this client does not speak, or the host refused the
 *   rules): `whenNoHost` decides, and it has no default. A gate that quietly lets writes through
 *   when its host is missing would be worse than none, so the package has to say which it wants:
 *     "block"  the calls its ask and never rules cover are blocked until a host takes the rules;
 *     handler  the package's own function runs for those calls and returns the verdict.
 *
 * Leaving `whenNoHost` out, or giving anything else, throws at registration.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { API_VERSION, findHost, type HostPack, isCovered, queuePending, type Registration } from "./registry.ts";
import { type LiveTool, type Rule, ruleApplies, snapshotRule } from "./rules.ts";
import { visible } from "./sanitize.ts";

export type { Rule, Verdict } from "./rules.ts";

/** The call a `whenNoHost` handler is asked about. `input` is the model's arguments: do not mutate it. */
export interface NoHostCall {
	toolName: string;
	toolCallId: string;
	parentToolCallId?: string;
	input: unknown;
}

/** The handler form of `whenNoHost`. Return `{ block: true, reason }` to stop the call, nothing to let it run. A throw blocks it. */
export type NoHostHandler = (
	call: NoHostCall,
	ctx: ExtensionContext,
	matchedRules: readonly Rule[],
) => ToolCallEventResult | void | Promise<ToolCallEventResult | void>;

export interface RegisterRulesOptions {
	/** Names the package. Registering the same id again replaces the earlier rules. */
	id: string;
	rules: readonly Rule[];
	/** No default. See the top of this file. */
	whenNoHost: "block" | NoHostHandler;
}

export interface RulesHandle {
	readonly id: string;
	/** "hosted": a host holds the rules. "no-host": `whenNoHost` is in force (a session without a host handler of its own is in force too). */
	state(): "hosted" | "no-host";
	/** Why a live host refused the rules, if it did. */
	error(): string | undefined;
	/** Take the rules out again. Called for you on `session_shutdown`. */
	dispose(): void;
}

const MAX_ID_CHARS = 100;

/**
 * What a `whenNoHost` handler may return: nothing (or null, or `{ block: false }`) lets the call
 * run, `{ block: true, reason? }` stops it. Anything else, such as `false`, `0`, `""`, `{}` or
 * `{ blocked: true }`, is a handler mistake and blocks: pi runs the call unless the result is an
 * object with a truthy `block`, so passing a malformed value through would let it run.
 */
function strictResult(result: unknown, id: string, toolName: string): ToolCallEventResult | undefined {
	if (result === undefined || result === null) return undefined;
	if (typeof result === "object" && !Array.isArray(result)) {
		const { block, reason } = result as { block?: unknown; reason?: unknown };
		if (block === false) return undefined;
		if (block === true) {
			return { block: true, reason: typeof reason === "string" && reason ? reason : `The "${visible(id)}" fallback blocked ${visible(toolName)}. Do not retry it; tell the user.` };
		}
	}
	return { block: true, reason: `The "${visible(id)}" fallback for ${visible(toolName)} returned something other than nothing or { block }, so the call was not run. Do not retry it; tell the user.` };
}

export function registerRules(pi: ExtensionAPI, options: RegisterRulesOptions): RulesHandle {
	if (typeof options !== "object" || options === null) throw new TypeError("registerRules needs an options object");
	const { id, rules, whenNoHost } = options;
	if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS) {
		throw new TypeError(`registerRules: id must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
	}
	if (whenNoHost !== "block" && typeof whenNoHost !== "function") {
		throw new TypeError(
			`registerRules("${visible(id)}"): whenNoHost is required, and must be "block" or a handler function. ` +
				"It says what happens to the calls these rules cover when pi-governor is not loaded; there is no safe default.",
		);
	}
	if (!Array.isArray(rules)) throw new TypeError(`registerRules("${visible(id)}"): rules must be an array`);
	const pack: HostPack = Object.freeze({ id, rules: Object.freeze(rules.map(snapshotRule)) });

	let hosted = false;
	let disposed = false;
	let lastError: string | undefined;
	let removeFromHost: (() => void) | undefined;
	let removePending: (() => void) | undefined;

	const registration: Registration = {
		apiVersion: API_VERSION,
		pack,
		owner: pi,
		accepted(remove) {
			if (disposed) return remove();
			hosted = true;
			lastError = undefined;
			removeFromHost = remove;
			removePending?.();
			removePending = undefined;
		},
		revoked() {
			hosted = false;
			removeFromHost = undefined;
			// Wait for the next host.
			if (!disposed) removePending = queuePending(registration);
		},
	};

	const host = findHost();
	if (host) {
		try {
			host.register(registration);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			// Keep it for a later host; until then whenNoHost is in force.
			removePending = queuePending(registration);
		}
	} else {
		removePending = queuePending(registration);
	}

	// An allow rule needs no enforcing when there is no host: only ask and never rules are covered.
	const enforceRules = pack.rules.filter((rule) => rule.verdict !== "allow");

	pi.on("tool_call", async (event, ctx) => {
		if (disposed || enforceRules.length === 0) return;
		// A host in the process is not enough: its tool_call handler must be in this session.
		if (hosted && isCovered(ctx.sessionManager)) return;
		let tool: LiveTool | undefined;
		try {
			tool = pi.getAllTools().find((t) => t.name === event.toolName);
		} catch {
			tool = undefined;
		}
		const call = { name: event.toolName, input: event.input };
		const matched = enforceRules.filter((rule) => ruleApplies(rule, call, tool));
		if (matched.length === 0) return;
		if (whenNoHost === "block") {
			return {
				block: true,
				reason:
					`${visible(event.toolName)} is covered by the "${visible(id)}" rules, which pi-governor enforces, ` +
					"and pi-governor is not loaded. The call was not run. Do not retry it; tell the user that pi-governor needs to be installed or enabled.",
			};
		}
		try {
			const result = await whenNoHost(
				{
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
					input: event.input,
				},
				ctx,
				matched,
			);
			return strictResult(result, id, event.toolName);
		} catch (error) {
			return {
				block: true,
				reason: `The "${visible(id)}" fallback for ${visible(event.toolName)} failed (${visible(error instanceof Error ? error.message : String(error))}), so the call was not run. Do not retry it; tell the user.`,
			};
		}
	});

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		hosted = false;
		removeFromHost?.();
		removePending?.();
		removeFromHost = undefined;
		removePending = undefined;
	};
	pi.on("session_shutdown", dispose);

	return { id, state: () => (hosted ? "hosted" : "no-host"), error: () => lastError, dispose };
}
