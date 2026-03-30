#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { rankTools, handleRankTool } from "./tools/rank.js";
import { eventsTools, handleEventsTool } from "./tools/events.js";
import { patternsTools, handlePatternsTool } from "./tools/patterns.js";
import { findTools, handleFindTool } from "./tools/find.js";
import { queryTools, handleQueryTool } from "./tools/query.js";

const server = new Server(
  { name: "uk-parliament", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

const allTools = [
  ...rankTools,
  ...eventsTools,
  ...patternsTools,
  ...findTools,
  ...queryTools,
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const safeArgs = (args ?? {}) as Record<string, unknown>;
  try {
    let result: string;
    if (name === "rank_entities") result = await handleRankTool(name, safeArgs);
    else if (name === "get_events") result = await handleEventsTool(name, safeArgs);
    else if (name === "analyze_patterns") result = await handlePatternsTool(name, safeArgs);
    else if (name === "find_entities") result = await handleFindTool(name, safeArgs);
    else if (name === "query_entities") result = await handleQueryTool(name, safeArgs);
    else throw new Error(`Unknown tool: ${name}`);
    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unknown error occurred.";
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
