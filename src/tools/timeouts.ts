/**
 * How long the transport waits for a tool (App. A).
 *
 * The MCP SDK defaults a request to 60s, and every bundled integration is
 * served over the in-memory transport (§11.1) — so that default is a ceiling
 * on every tool call in the system, whether or not anybody chose it. It
 * happened to be *exactly* `PRINT_TIMEOUT_MS`, and a tie goes to the
 * transport: a slow PDF export came back as `tool_failed: MCP error -32001:
 * Request timed out` rather than the tool's own `print_failed: timed out
 * after 60000ms`, and `print.ts`'s log of chromium's stderr — the one thing
 * that would have explained the failure — never got to flush.
 *
 * The transport is not the thing that decides a tool failed. This sits above
 * every tool's own budget so the tool's timeout always fires first and the
 * error says something true about what was being done.
 */
export const TOOL_CALL_TIMEOUT_MS = 120_000;
