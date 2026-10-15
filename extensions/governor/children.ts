/**
 * Subagent children. pi-subagents (0.78 and later) lets a host name extensions every native Pi
 * child must load, through `registerRequiredChildExtensions` in `pi-subagents/required-child-extensions`.
 * The host registers itself there, so a child gets a governor even where the agent's own
 * `extensions` list (or a foreground child's default of none) would leave it out.
 *
 * Measured on pi 1.2.0 with pi-subagents 0.78.0 (docs/design.md, Findings):
 * - A foreground child loads only listed and required extensions. Without this, it ran with no
 *   governor at all: a pack's `never` rule did not stop the call.
 * - pi-subagents looks registrations up by `sessionManager.getSessionId()`, for foreground and
 *   background launches. A registration under the session file path is never found, and the child
 *   silently gets nothing, so the id is the only key used here.
 * - A foreground child runs in the parent's process and reads the same rule store, so every pack
 *   the parent registered applies there. A background child is a process of its own: it has the
 *   host, and so the source defaults, but a pack's rules only if that pack loads in it too.
 *
 * pi-subagents is optional. Without it the host reports children as not known, never as covered.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** What this session did about its children, for `/governor`. */
export type ChildCoverage =
	| { state: "pending" }
	| { state: "absent" }
	| { state: "registered" }
	| { state: "failed"; error: string };

export interface RequiredChildHook {
	registerRequiredChildExtensions(input: { sessionId: string; extensions: Array<{ id: string; path: string }> }): { dispose(): void };
}

/** The id pi-subagents shows in its evidence for this extension. */
export const CHILD_EXTENSION_ID = "pi-governor";

/** A tool as `pi.getAllTools()` reports it: only where it came from matters here. */
export interface ToolSource {
	sourceInfo?: { path?: string; baseDir?: string };
}

/**
 * The hook file inside the pi-subagents package this process loaded, found from the source of one
 * of its tools and resolved through the package's own `exports` map ("./required-child-extensions"),
 * not a guessed path. Undefined when no loaded tool comes from a package named pi-subagents.
 */
export function hookFromLoadedPackage(tools: readonly ToolSource[]): string | undefined {
	for (const tool of tools) {
		const start = tool.sourceInfo?.baseDir ?? (tool.sourceInfo?.path ? dirname(tool.sourceInfo.path) : undefined);
		for (let dir = start; dir && dir !== dirname(dir); dir = dirname(dir)) {
			const manifest = join(dir, "package.json");
			if (!existsSync(manifest)) continue;
			try {
				const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; exports?: Record<string, unknown> };
				if (pkg.name !== "pi-subagents") break;
				const entry = pkg.exports?.["./required-child-extensions"];
				const target = typeof entry === "string" ? entry : (entry as { default?: unknown } | undefined)?.default;
				if (typeof target !== "string" || !target.startsWith("./")) break;
				// The entry must stay inside the package: "./../x" starts with "./" and still leaves it.
				const root = resolve(dir);
				const file = resolve(root, target);
				if (!file.startsWith(root + sep) || !existsSync(file)) break;
				return pathToFileURL(file).href;
			} catch {
				// unreadable manifest: keep looking with the next tool
			}
			break;
		}
	}
	return undefined;
}

/**
 * Where pi-subagents' hook can be imported from, best first: the package this process actually
 * loaded (found from its tools), then the package name, then the agent dir's npm folder.
 */
export function hookSpecifiers(tools: readonly ToolSource[] = [], env: NodeJS.ProcessEnv = process.env): string[] {
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const loaded = hookFromLoadedPackage(tools);
	return [
		...(loaded ? [loaded] : []),
		"pi-subagents/required-child-extensions",
		pathToFileURL(join(agentDir, "npm", "node_modules", "pi-subagents", "src", "api", "required-child-extensions.js")).href,
	];
}

/** pi-subagents' hook, or undefined when it is not installed (or has no such export). */
export async function loadRequiredChildHook(specifiers: readonly string[] = hookSpecifiers()): Promise<RequiredChildHook | undefined> {
	for (const spec of specifiers) {
		try {
			const mod = (await import(spec)) as Partial<RequiredChildHook>;
			if (typeof mod.registerRequiredChildExtensions === "function") return mod as RequiredChildHook;
		} catch {
			// not installed there; try the next place
		}
	}
	return undefined;
}

/** The host module itself, as a file path pi-subagents can load into a child. */
export function hostModulePath(hostUrl: string): string {
	return fileURLToPath(hostUrl);
}

/**
 * Register the host as an extension every child of `sessionId` must load. Returns the handle to
 * dispose on shutdown. Throws what pi-subagents throws (for example when another package already
 * registered for this session: pi-subagents allows one registration per session).
 */
export function registerForChildren(hook: RequiredChildHook, sessionId: string, hostPath: string): { dispose(): void } {
	if (!sessionId) throw new Error("this session has no id to register children under");
	return hook.registerRequiredChildExtensions({ sessionId, extensions: [{ id: CHILD_EXTENSION_ID, path: hostPath }] });
}
