# GitNexus for Cursor

GitNexus integrates with Cursor through MCP and skills only. Lifecycle hooks
were retired because they created hidden work on every tool invocation and
could fail independently of the requested operation.

Run `gitnexus analyze` explicitly from the project root when the index is stale.
Install the skills in this directory through `gitnexus setup`, then configure
the GitNexus MCP server in Cursor. No files belong in `.cursor/hooks.json` or a
project `hooks/` directory.
