/** The release script's version bump and changelog cut. Run with: pnpm test */

import assert from "node:assert/strict";
import { test } from "node:test";

const { cutChangelog, nextVersion } = await import("../scripts/release.mjs");
const URL_ = "https://github.com/example/pi-governor";

test("nextVersion follows semver", () => {
	assert.equal(nextVersion("0.0.0", "minor"), "0.1.0");
	assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
	assert.equal(nextVersion("0.1.3", "minor"), "0.2.0");
	assert.equal(nextVersion("0.9.9", "major"), "1.0.0");
	assert.equal(nextVersion("1.2.0-rc.1", "patch"), "1.2.0", "a pre-release patches to its own version");
	assert.equal(nextVersion("0.1.0", "0.3.0"), "0.3.0");
	assert.throws(() => nextVersion("0.1.0", "huge"));
});

test("cutChangelog for the first release adds a tag link and moves the entries", () => {
	const before = `# Changelog\n\n## [Unreleased]\n\nFirst release.\n\n### Added\n\n- Things.\n\n[Unreleased]: ${URL_}/commits/main\n`;
	const after = cutChangelog(before, "0.1.0", "2026-10-20", URL_);
	assert.match(after, /## \[Unreleased\]\n\n## \[0\.1\.0\] - 2026-10-20\n\nFirst release\.\n\n### Added\n\n- Things\./);
	assert.match(after, new RegExp(`\\[Unreleased\\]: ${URL_}/compare/v0\\.1\\.0\\.\\.\\.HEAD`));
	assert.match(after, new RegExp(`\\[0\\.1\\.0\\]: ${URL_}/releases/tag/v0\\.1\\.0`));
});

test("cutChangelog moves Unreleased under the new version and updates the links", () => {
	const before = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A bug.\n\n## [0.1.0] - 2026-10-08\n\nFirst.\n\n[Unreleased]: ${URL_}/compare/v0.1.0...HEAD\n[0.1.0]: ${URL_}/releases/tag/v0.1.0\n`;
	const after = cutChangelog(before, "0.1.1", "2026-11-01", URL_);
	assert.match(after, /## \[Unreleased\]\n\n## \[0\.1\.1\] - 2026-11-01\n\n### Fixed\n\n- A bug\.\n\n## \[0\.1\.0\]/);
	assert.match(after, new RegExp(`\\[0\\.1\\.1\\]: ${URL_}/compare/v0\\.1\\.0\\.\\.\\.v0\\.1\\.1`));
});

test("cutChangelog refuses an empty Unreleased section", () => {
	assert.throws(() => cutChangelog(`## [Unreleased]\n\n## [0.1.0] - x\n`, "0.1.1", "d", URL_), /empty/);
});
