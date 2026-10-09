# Changelog

All notable changes to pi-containment are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Package scaffold: TypeScript sources under `extensions/`, `node --test` tests, and a peer dependency on `@earendil-works/pi-coding-agent` `>=1.1.0 <1.2.0`.
- `computeMcpToolNames(server, tool)`: the plain and hash-suffixed names pi 1.1 can register for an MCP tool, for matching rules against live tool names.
