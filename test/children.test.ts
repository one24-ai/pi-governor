/**
 * children.ts: finding pi-subagents' hook and registering the host for subagent children.
 *
 * One test runs against the installed pi-subagents (skipped when it is absent), because the bug
 * this module exists to avoid is a key mismatch that a fake hook cannot show: pi-subagents looks
 * registrations up by the session id, and a registration under any other key is silently ignored.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CHILD_EXTENSION_ID, hookFromLoadedPackage, hookSpecifiers, hostModulePath, loadRequiredChildHook, registerForChildren, type RequiredChildHook } from "../extensions/governor/children.ts";

const HOST_PATH = hostModulePath(new URL("../extensions/governor/host.ts", import.meta.url).href);

test("hookSpecifiers: the loaded package first, then the package name, then the agent dir's npm folder", () => {
	const specs = hookSpecifiers([], { PI_CODING_AGENT_DIR: "/agent" });
	assert.deepEqual(specs, ["pi-subagents/required-child-extensions", pathToFileURL("/agent/npm/node_modules/pi-subagents/src/api/required-child-extensions.js").href]);
	assert.match(hookSpecifiers([], {})[1]!, new RegExp(`${homedir()}/\\.pi/agent/npm/`));
});

function fakePackage(name: string, exportsEntry: unknown, layout: "nested" | "root" = "nested") {
	const root = mkdtempSync(join(tmpdir(), "governor-pkg-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name, ...(exportsEntry === undefined ? {} : { exports: { "./required-child-extensions": exportsEntry } }) }));
	if (layout === "nested") mkdirSync(join(root, "src", "runs"), { recursive: true });
	return root;
}

test("hookFromLoadedPackage: finds pi-subagents from a tool's source and follows its exports map", () => {
	const root = fakePackage("pi-subagents", { types: "./x.d.ts", default: "./src/api/required-child-extensions.js" });
	try {
		const fromPath = hookFromLoadedPackage([{ sourceInfo: { path: join(root, "src", "runs", "index.js") } }]);
		assert.equal(fromPath, pathToFileURL(join(root, "src", "api", "required-child-extensions.js")).href);
		assert.equal(hookFromLoadedPackage([{ sourceInfo: { baseDir: root } }]), fromPath, "baseDir works too");
		assert.deepEqual(hookSpecifiers([{ sourceInfo: { baseDir: root } }], { PI_CODING_AGENT_DIR: "/agent" })[0], fromPath, "it comes first");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hookFromLoadedPackage: a string exports entry, other packages, and odd manifests", () => {
	const plain = fakePackage("pi-subagents", "./hook.js", "root");
	const other = fakePackage("some-other-package", "./hook.js", "root");
	const noExport = fakePackage("pi-subagents", undefined, "root");
	const escaping = fakePackage("pi-subagents", "../../etc/hook.js", "root");
	try {
		assert.equal(hookFromLoadedPackage([{ sourceInfo: { baseDir: plain } }]), pathToFileURL(join(plain, "hook.js")).href);
		assert.equal(hookFromLoadedPackage([{ sourceInfo: { baseDir: other } }]), undefined, "the nearest package.json decides; another package is not pi-subagents");
		assert.equal(hookFromLoadedPackage([{ sourceInfo: { baseDir: noExport } }]), undefined, "no exports entry: not this way");
		assert.equal(hookFromLoadedPackage([{ sourceInfo: { baseDir: escaping } }]), undefined, "only ./ entries inside the package");
		assert.equal(hookFromLoadedPackage([{}, { sourceInfo: {} }]), undefined);
		assert.equal(hookFromLoadedPackage([{ sourceInfo: { baseDir: other } }, { sourceInfo: { baseDir: plain } }]), pathToFileURL(join(plain, "hook.js")).href, "any tool from pi-subagents will do");
	} finally {
		for (const d of [plain, other, noExport, escaping]) rmSync(d, { recursive: true, force: true });
	}
});

test("loadRequiredChildHook: first module that exports the function; undefined when none does", async () => {
	const dir = mkdtempSync(join(tmpdir(), "governor-hook-"));
	try {
		const good = join(dir, "good.mjs");
		const wrong = join(dir, "wrong.mjs");
		writeFileSync(good, "export function registerRequiredChildExtensions() { return { dispose() {} }; }\n");
		writeFileSync(wrong, "export const registerRequiredChildExtensions = 42;\n");
		const missing = pathToFileURL(join(dir, "missing.mjs")).href;
		const hook = await loadRequiredChildHook([missing, pathToFileURL(wrong).href, pathToFileURL(good).href]);
		assert.equal(typeof hook?.registerRequiredChildExtensions, "function");
		assert.equal(await loadRequiredChildHook([missing, pathToFileURL(wrong).href]), undefined);
		assert.equal(await loadRequiredChildHook(["no-such-package/required-child-extensions"]), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("registerForChildren: registers the host file under the session id and the pi-governor id", () => {
	const seen: unknown[] = [];
	const hook: RequiredChildHook = { registerRequiredChildExtensions: (input) => (seen.push(input), { dispose() {} }) };
	registerForChildren(hook, "01abc", HOST_PATH);
	assert.deepEqual(seen, [{ sessionId: "01abc", extensions: [{ id: CHILD_EXTENSION_ID, path: HOST_PATH }] }]);
	assert.throws(() => registerForChildren(hook, "", HOST_PATH), /no id/);
});

test("hostModulePath points at a file that exists", () => {
	assert.ok(existsSync(HOST_PATH));
	assert.match(HOST_PATH, /extensions\/governor\/host\.ts$/);
});

// ---- against the installed pi-subagents -----------------------------------------------------------

const installed = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "npm", "node_modules", "pi-subagents", "src", "shared", "required-child-extensions.js");

test("with the installed pi-subagents, a child launch finds the registration by session id", { skip: !existsSync(installed) && "pi-subagents is not installed in the agent dir" }, async () => {
	const pkgDir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "npm", "node_modules", "pi-subagents");
	const fromTool = hookFromLoadedPackage([{ sourceInfo: { path: join(pkgDir, "index.js"), baseDir: pkgDir } }]);
	assert.ok(fromTool, "the real package is found from where its tool was loaded, through its exports map");
	const hook = await loadRequiredChildHook([fromTool!]);
	assert.ok(hook, "and the hook loads from there");
	const shared = (await import(pathToFileURL(installed).href)) as { resolveRequiredChildExtensions(id?: string): ReadonlyArray<{ id: string; path: string }> };
	const sessionId = `governor-test-${process.pid}-${Date.now()}`;
	const registration = registerForChildren(hook!, sessionId, HOST_PATH);
	try {
		const found = shared.resolveRequiredChildExtensions(sessionId);
		assert.deepEqual(found.map((e) => e.id), [CHILD_EXTENSION_ID]);
		assert.ok(found[0]!.path.endsWith("extensions/governor/host.ts"));
		assert.deepEqual(shared.resolveRequiredChildExtensions(`/sessions/${sessionId}.jsonl`), [], "a registration is found only by the exact id");
		assert.throws(() => registerForChildren(hook!, sessionId, HOST_PATH), /already registered/, "pi-subagents allows one registration per session");
	} finally {
		registration.dispose();
	}
	assert.deepEqual(shared.resolveRequiredChildExtensions(sessionId), [], "dispose removes it");
});
