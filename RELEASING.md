# Releasing pi-governor

Every release is a commit on `main` with a `vX.Y.Z` tag, made once and pushed unchanged. Releases are cut and pushed by the owner; nothing here is run by an agent.

## Where it lives

| Place | What |
|---|---|
| `github.com/one24-ai/pi-governor` | The repository: issues, pull requests, CI, tags |
| npmjs.com, `pi-governor` | The published package, built and published by CI from a tag with npm trusted publishing |

Code that is specific to one company does not go into pi-governor: it lives in a separate package that registers rules through `pi-governor/client`.

## Versions

Semantic versioning. While the version is 0.x, a breaking change bumps the minor version. Every change a user could notice gets a line under `## [Unreleased]` in `CHANGELOG.md`, in the same commit or pull request, under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security`. The release script refuses to cut a release while that section is empty.

This repository's rules are fail-closed. A change that makes a rule, a default or a block path looser is a breaking change and the changelog says so.

## Cut a release

On `main`, with a clean tree:

```bash
pnpm release minor --dry-run   # shows the changelog it would write; changes nothing
pnpm release minor             # or patch, major, or an exact version such as 0.2.0
```

`pnpm release` checks that the tree is clean and on `main`, runs `pnpm check`, bumps `package.json`, moves the Unreleased entries under the new version with today's date, commits `Release X.Y.Z` and creates the annotated tag `vX.Y.Z`. It does not push or publish. Do not edit `version` by hand.

Then push the commit and the tag:

```bash
git push origin main --follow-tags
```

The tag starts `.github/workflows/release.yml`, which runs the checks again, verifies the tag matches `package.json`, publishes to npm, and creates the GitHub release from the changelog entry. If that version is already on npm, the publish step is skipped.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC): no npm token is stored in GitHub. npm accepts the run because the package's trusted publisher names this repository, `release.yml` and the `npm` environment. If a run fails at `npm publish` with a 404 or 403, check those three names on npmjs.com first: they must match exactly.

## The first release (0.1.0), once

`pi-governor@0.0.0` already exists on npm as a name placeholder, so the package can have a trusted publisher before its first real version. Do these in order:

1. Merge the pull request into `main` with **Squash and merge**.
2. `git checkout main && git pull`, then `pnpm release minor`. Do not push yet.
3. Publish `0.1.0` by hand from the tagged commit, with 2FA. This needs a working `npm login`:

   ```bash
   git checkout v0.1.0 && pnpm install --frozen-lockfile && pnpm check
   npm publish --provenance=false   # prompts for the 2FA code
   git checkout main
   ```

4. On npmjs.com, package `pi-governor`, Settings, Trusted Publisher, GitHub Actions: organization `one24-ai`, repository `pi-governor`, workflow `release.yml`, environment `npm`. Or, with npm 11.15 or later and 2FA:

   ```bash
   npm trust github pi-governor --file release.yml --repo one24-ai/pi-governor --env npm --allow-publish
   ```

   A new trusted publisher must complete its first publish within 2 days, so cut the next release soon after.
5. Push the commit and the tag: `git push origin main --follow-tags`. The workflow sees `0.1.0` is already published, skips it, and creates the GitHub release.

## One-time setup

1. **No tokens.** Do not add an npm token to the repository.
2. **GitHub.** `main` should require the CI check and not be force-pushed or deleted. The `release tags` ruleset already limits `v*` tags to admins, because pushing one publishes. Create an environment named `npm` (Settings, Environments) that only runs for `v*.*.*` tags.
3. **Pinned actions.** The workflows pin each action to a commit hash with the version in a comment. To update one, change the hash and the comment together, after checking the hash is the release's commit.
4. **pi version.** CI installs the pi version in `peerDependencies` so the tests link the right pi. Change `1.2.0` in both workflows when the supported range changes.
