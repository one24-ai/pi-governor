/**
 * Reading governor.json from disk. rules.ts holds the parsing and the merge; this is the only
 * part that touches the file system.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParsedConfig, parseConfig } from "./rules.ts";

export interface ConfigSource {
	path: string;
	/** undefined: the file does not exist. */
	parsed: ParsedConfig | undefined;
}

/** Read and parse one file. A missing file is `undefined`; any other read problem is an error, which makes every source ask. */
export function readConfig(path: string): ConfigSource {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, parsed: undefined };
		return { path, parsed: { ok: false, error: `could not be read: ${(error as Error).message}` } };
	}
	return { path, parsed: parseConfig(text) };
}

export function globalConfigPath(agentDir: string): string {
	return join(agentDir, "governor.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "governor.json");
}
