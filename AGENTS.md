# pi-governor: notes for agents working in this repo

- This is a general-purpose package. Nothing specific to one company, its hosts, services or tools goes in code, docs, tests or examples.
- Use pnpm, never npm or yarn.
- It is a safety control: fail closed. A missing host, a missing UI or an unknown tool must never mean a call goes through unasked. See docs/design.md.
- Every change a user could notice gets a line under `## [Unreleased]` in `CHANGELOG.md` in the same commit (Added, Changed, Deprecated, Removed, Fixed, Security). Say if it is breaking.
- Releases are cut and pushed by the owner.
- No em dashes anywhere.
