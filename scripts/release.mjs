#!/usr/bin/env node
/**
 * Adapted from pi-chassis (MIT, same author).
 *
 * Cut a release: bump the version, move the Unreleased changelog entries under the new version,
 * commit and tag. It never pushes and never publishes; it prints the commands to do that.
 *
 *   pnpm release patch|minor|major      bump from the current version
 *   pnpm release 0.2.0                  set an exact version
 *   pnpm release minor --dry-run        show what would happen, change nothing
 *
 * It refuses to run on a dirty tree, off the main branch, with an empty Unreleased section, or
 * when the checks (`pnpm check`) fail. Pushing the tag makes CI publish to npm.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const want = args.find((a) => !a.startsWith("--"));

const fail = (message) => {
	console.error(`release: ${message}`);
	process.exit(1);
};
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** The next version for a bump keyword, or the exact version given. */
export function nextVersion(current, bump) {
	const m = SEMVER.exec(current);
	if (!m) throw new Error(`current version ${current} is not semver`);
	const [major, minor, patch] = m.slice(1, 4).map(Number);
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	if (bump === "patch") return m[4] ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
	if (SEMVER.test(bump)) return bump;
	throw new Error(`"${bump}" is not patch, minor, major or a version like 1.2.3`);
}

/** Move the Unreleased entries under a new version heading and update the compare links. */
export function cutChangelog(text, version, date, repoUrl) {
	const head = "## [Unreleased]";
	const start = text.indexOf(head);
	if (start < 0) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
	const bodyStart = start + head.length;
	const next = text.indexOf("\n## [", bodyStart);
	const body = text.slice(bodyStart, next < 0 ? undefined : next).trim();
	if (!body) throw new Error("the Unreleased section is empty: add the changes first");
	const rest = next < 0 ? "" : text.slice(next + 1);
	let out = `${text.slice(0, start)}${head}\n\n## [${version}] - ${date}\n\n${body}\n\n${rest}`;
	const prev = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(rest)?.[1];
	out = out.replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`);
	const link = prev ? `[${version}]: ${repoUrl}/compare/v${prev}...v${version}` : `[${version}]: ${repoUrl}/releases/tag/v${version}`;
	out = out.replace(/^(\[Unreleased\]: .*)$/m, `$1\n${link}`);
	return out.replace(/\n{3,}/g, "\n\n");
}

function main() {
	if (!want) fail("say which bump: pnpm release patch|minor|major|<version> [--dry-run]");
	const pkgPath = join(root, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	let version;
	try {
		version = nextVersion(pkg.version, want);
	} catch (e) {
		fail(e.message);
	}
	const repoUrl = String(pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
	if (!repoUrl) fail("package.json has no repository.url");

	if (git("status", "--porcelain")) fail("the working tree has uncommitted changes");
	const branch = git("branch", "--show-current");
	if (branch !== "main") fail(`releases are cut from main, not ${branch || "a detached HEAD"}`);
	if (git("tag", "--list", `v${version}`)) fail(`tag v${version} already exists`);

	const date = new Date().toISOString().slice(0, 10);
	const changelogPath = join(root, "CHANGELOG.md");
	let changelog;
	try {
		changelog = cutChangelog(readFileSync(changelogPath, "utf8"), version, date, repoUrl);
	} catch (e) {
		fail(e.message);
	}

	console.log(`release: ${pkg.version} -> ${version}${dryRun ? " (dry run)" : ""}`);
	if (dryRun) {
		console.log(changelog.split("\n").slice(0, 30).join("\n"));
		return;
	}
	execFileSync("pnpm", ["check"], { cwd: root, stdio: "inherit" });
	pkg.version = version;
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
	writeFileSync(changelogPath, changelog);
	git("add", "package.json", "CHANGELOG.md");
	git("commit", "-m", `Release ${version}`);
	git("tag", "-a", `v${version}`, "-m", `pi-governor ${version}`);
	console.log(`\nTagged v${version}. To publish:\n  git push origin main --follow-tags\nCI publishes v${version} to npm when the tag arrives. To mirror it elsewhere, see RELEASING.md.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
