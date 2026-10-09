# pi-containment

A guard layer for [pi](https://pi.dev) tool calls. Not yet implemented: this repo holds the design, and the npm package is a placeholder that reserves the name.

pi-containment decides, in one place, which tool calls the model may make, which need your approval first, and which are never allowed. Other packages register rules with it. A later phase adds an optional OS sandbox for bash.

It is not a full sandbox. It gates tool calls (including MCP and extension tools) and, in phase 2, confines bash commands. pi's own process, other extensions' code and MCP servers still run with your permissions. For full isolation, run pi in a container (see pi's `docs/containerization.md`).

See [docs/design.md](docs/design.md) for the design.

## License

MIT
