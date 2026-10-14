/**
 * The guard: for one `tool_call`, decide, and for `ask` open the one dialog. It has no pi
 * dependency beyond types, so every path is unit tested with fakes. host.ts wires it to pi.
 *
 * Every failure path blocks (docs/design.md, "One dialog, one fail-closed path"):
 * - a `never` verdict blocks, with a reason that tells the model not to retry;
 * - an `ask` with no way to ask blocks, and the reason says to ask the user in the reply;
 * - a declined dialog blocks and says not to retry; a dialog nobody answered blocks and says so;
 * - an exception anywhere in the check blocks.
 */

import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { buildDialog, effectiveWindowMs } from "./dialog.ts";
import type { HostPack } from "./registry.ts";
import { type ConfigurableSource, decide, type Decision, type LiveTool, type Rule, type SourceDefault } from "./rules.ts";
import { visible } from "./sanitize.ts";

/** How long a dialog waits for an answer before it counts as a decline. */
export const DEFAULT_DIALOG_TIMEOUT_MS = 120_000;
/** A decline this close to the timeout is reported as an unanswered dialog. */
const TIMEOUT_SLACK_MS = 250;
/** How long past its timeout the guard waits for a UI that ignores the dialog timeout. */
export const DEFAULT_DIALOG_GRACE_MS = 5_000;
const MAX_TRACKED_CALLS = 2000;
const MAX_APPROVALS = 500;

export interface GuardEvent {
	toolName: string;
	toolCallId: string;
	parentToolCallId?: string;
	input: unknown;
}

export interface GuardContext {
	hasUI: boolean;
	ui: { confirm(title: string, message: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<boolean> };
	signal?: AbortSignal | undefined;
}

export interface GuardDeps {
	/** The registered rule packs, read for every call. */
	packs(): readonly HostPack[];
	/** The live tool list (`pi.getAllTools()`), read for every call. */
	tools(): readonly LiveTool[];
	defaults(): Record<ConfigurableSource, SourceDefault>;
	now?(): number;
	dialogTimeoutMs?: number;
	/** Extra time past the dialog's own timeout before the guard stops waiting for a UI that ignores it. */
	dialogGraceMs?: number;
}

export interface ApprovalInfo {
	tool: string;
	expiresAt: number;
}

const block = (reason: string): ToolCallEventResult => ({ block: true, reason });

export class Guard {
	readonly #deps: GuardDeps;
	readonly #now: () => number;
	readonly #timeout: number;
	readonly #grace: number;
	/** Tool names of calls that started, so a nested call's parent can be named. `null`: the id was used for two different tools, so it names none. */
	readonly #started = new Map<string, string | null>();
	readonly #approved = new Map<string, ApprovalInfo>();
	readonly #ruleIds = new WeakMap<Rule, number>();
	#nextRuleId = 1;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(deps: GuardDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#timeout = deps.dialogTimeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS;
		this.#grace = deps.dialogGraceMs ?? DEFAULT_DIALOG_GRACE_MS;
	}

	/** From `tool_execution_start`: remember which tool a call id belongs to. */
	noteStart(toolCallId: string, toolName: string): void {
		const known = this.#started.get(toolCallId);
		// The model can influence call ids. One id for two different tools names neither.
		this.#started.set(toolCallId, known === undefined || known === toolName ? toolName : null);
		if (this.#started.size > MAX_TRACKED_CALLS) {
			const oldest = this.#started.keys().next().value;
			if (oldest !== undefined) this.#started.delete(oldest);
		}
	}

	/** From `tool_execution_end`. */
	noteEnd(toolCallId: string): void {
		this.#started.delete(toolCallId);
	}

	/** Live approvals, soonest to expire first. */
	approvals(): ApprovalInfo[] {
		this.#pruneApprovals();
		return [...this.#approved.values()].sort((a, b) => a.expiresAt - b.expiresAt);
	}

	/** Drop every approval, for example when the session changes. */
	clearApprovals(): void {
		this.#approved.clear();
	}

	async check(event: GuardEvent, ctx: GuardContext): Promise<ToolCallEventResult | undefined> {
		try {
			return await this.#check(event, ctx);
		} catch (error) {
			const why = visible(error instanceof Error ? error.message : String(error));
			return block(`pi-governor could not check ${visible(event.toolName)} (${why}), so the call was not run. Do not retry it; tell the user.`);
		}
	}

	async #check(event: GuardEvent, ctx: GuardContext): Promise<ToolCallEventResult | undefined> {
		const rules = this.#deps.packs().flatMap((pack) => pack.rules);
		const tool = this.#deps.tools().find((t) => t.name === event.toolName);
		const decision = decide({ name: event.toolName, input: event.input }, tool, rules, this.#deps.defaults());
		const name = visible(event.toolName);

		if (decision.verdict === "allow") return undefined;
		if (decision.verdict === "never") {
			return block(`${name} is never allowed here: ${visible(decision.why)}. Do not retry it. If the user wants it, they can change the pi-governor rules or run it themselves.`);
		}
		if (decision.verdict !== "ask") return block(`pi-governor reached an unexpected verdict for ${name}, so the call was not run. Do not retry it; tell the user.`);
		if (this.#parentIsTrusted(event, decision)) return undefined;
		// One dialog at a time: parallel calls would otherwise stack several, and a window approval
		// from the first can then cover the others.
		return this.#serialized(() => this.#ask(event, ctx, decision));
	}

	#parentIsTrusted(event: GuardEvent, decision: Decision): boolean {
		if (!event.parentToolCallId || decision.rules.length === 0) return false;
		const parent = this.#started.get(event.parentToolCallId);
		if (parent === undefined || parent === null) return false;
		return decision.rules.every((rule) => rule.trustedParents?.includes(parent) === true);
	}

	async #ask(event: GuardEvent, ctx: GuardContext, decision: Decision): Promise<ToolCallEventResult | undefined> {
		const name = visible(event.toolName);
		// Calls queued behind an earlier dialog may have been aborted while they waited.
		if (ctx.signal?.aborted) return block(`The operation was aborted before ${name} was approved, so it was not run.`);
		const window = effectiveWindowMs(decision.rules);
		const key = window === undefined ? undefined : this.#approvalKey(event.toolName, decision.rules);
		if (key !== undefined) {
			const held = this.#approved.get(key);
			if (held && held.expiresAt > this.#now()) return undefined;
		}
		if (!ctx.hasUI) {
			return block(
				`${name} needs the user's approval, and there is no way to ask in this session (it runs without an interactive UI, for example print mode or a subagent). ` +
					"The call was not run. Do not retry it; ask the user in your reply, or have them run it themselves.",
			);
		}
		const { title, message } = buildDialog({ toolName: event.toolName, input: event.input, decision });
		const opened = this.#now();
		let allowed: boolean | "stalled";
		let stall: ReturnType<typeof setTimeout> | undefined;
		try {
			// pi enforces the dialog timeout, but a UI that ignores it must not stall every later ask.
			const stalled = new Promise<"stalled">((resolve) => {
				stall = setTimeout(() => resolve("stalled"), this.#timeout + this.#grace);
				stall.unref?.();
			});
			allowed = await Promise.race([ctx.ui.confirm(title, message, { timeout: this.#timeout, ...(ctx.signal ? { signal: ctx.signal } : {}) }), stalled]);
		} catch (error) {
			return block(`The approval dialog for ${name} failed (${visible(error instanceof Error ? error.message : String(error))}), so the call was not run. Do not retry it; tell the user.`);
		} finally {
			if (stall) clearTimeout(stall);
		}
		if (allowed === "stalled") return block(`The approval dialog for ${name} did not answer in time, so it was not run. Do not retry it; ask the user in your reply.`);
		if (allowed === true) {
			if (key !== undefined && window !== undefined) this.#remember(key, event.toolName, window);
			return undefined;
		}
		if (ctx.signal?.aborted) return block(`The operation was aborted before ${name} was approved, so it was not run.`);
		if (this.#now() - opened >= this.#timeout - TIMEOUT_SLACK_MS) {
			return block(`Nobody answered the approval dialog for ${name}, so it was not run. Do not retry it; ask the user in your reply.`);
		}
		return block(`The user declined ${name}. Do not retry it or look for another way to do the same thing; ask the user what they want instead.`);
	}

	#remember(key: string, tool: string, windowMs: number): void {
		this.#pruneApprovals();
		if (this.#approved.size >= MAX_APPROVALS) {
			const oldest = this.#approved.keys().next().value;
			if (oldest !== undefined) this.#approved.delete(oldest);
		}
		this.#approved.set(key, { tool, expiresAt: this.#now() + windowMs });
	}

	#pruneApprovals(): void {
		const now = this.#now();
		for (const [key, info] of this.#approved) if (info.expiresAt <= now) this.#approved.delete(key);
	}

	/** An approval covers one tool and the exact rules that asked for it. */
	#approvalKey(toolName: string, rules: readonly Rule[]): string {
		const ids = rules.map((rule) => {
			let id = this.#ruleIds.get(rule);
			if (id === undefined) this.#ruleIds.set(rule, (id = this.#nextRuleId++));
			return id;
		});
		return `${toolName}\0${ids.sort((a, b) => a - b).join(",")}`;
	}

	#serialized<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn, fn);
		this.#queue = run.catch(() => undefined);
		return run;
	}
}
