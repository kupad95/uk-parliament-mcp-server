// rank_entities tool — rank MPs by rebellion count

import {
  fetchDivisionSummaries,
  fetchDivisionDetail,
  detectCommonsRebels,
  detectLordsRebels,
  formatDate,
  type CommonsDivisionDetail,
  type LordsDivisionDetail,
  type DivisionSummary,
} from "./shared.js";
import { batchedFetch } from "../api/client.js";

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const rankTools = [
  {
    name: "rank_entities",
    description:
      "Rank MPs by rebellion count — how many times they voted against their party whip. Use this for any question about 'most rebellious MPs', 'rebel count', 'which Labour/Conservative MPs rebelled most', or rebellion frequency rankings. Scans all divisions in the date range internally and returns a sorted leaderboard in a single call. Filter by party='Labour' for Labour-specific results.",
    inputSchema: {
      type: "object",
      properties: {
        entity_type: {
          type: "string",
          enum: ["mp"],
          description: "The type of entity to rank.",
        },
        metric: {
          type: "string",
          enum: ["rebellions"],
          description: "The metric to rank by.",
        },
        party: {
          type: "string",
          description: "Filter to a specific party (e.g. 'Labour').",
        },
        house: {
          type: "string",
          enum: ["Commons", "Lords"],
          description: "Which house to scan. Defaults to Commons.",
        },
        date_from: {
          type: "string",
          description:
            "Start date in YYYY-MM-DD format. Defaults to 2024-07-05 (current parliament).",
        },
        max_divisions: {
          type: "number",
          description:
            "Maximum number of divisions to scan. Default 100, max 500.",
        },
        min_rebellions: {
          type: "number",
          description: "Minimum rebellions to appear in the leaderboard. Default 1.",
        },
        limit: {
          type: "number",
          description: "Maximum number of MPs to return. Default 20.",
        },
      },
      required: ["entity_type", "metric"],
    },
  },
];

// ─── Handler ──────────────────────────────────────────────────────────────────

interface RebelRecord {
  name: string;
  party: string;
  constituency: string;
  count: number;
  recentDivisions: string[];
}

export async function handleRankTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    if (name !== "rank_entities") {
      throw new Error(`Unknown tool: ${name}`);
    }

    const entityType = args.entity_type as string;
    const metric = args.metric as string;

    if (entityType !== "mp" || metric !== "rebellions") {
      throw new Error(
        `Unsupported entity_type/metric combination: ${entityType}/${metric}`
      );
    }

    const house = (args.house as "Commons" | "Lords") ?? "Commons";
    const dateFrom = (args.date_from as string) ?? "2024-07-05";
    const maxDivisions = Math.min(
      (args.max_divisions as number) ?? 100,
      500
    );
    const minRebellions = (args.min_rebellions as number) ?? 1;
    const limit = (args.limit as number) ?? 20;
    const partyFilter = args.party as string | undefined;

    // Fetch division summaries
    const summaries = await fetchDivisionSummaries(house, dateFrom, maxDivisions);

    // Fetch all division details in parallel batches
    const rebelMap = new Map<number, RebelRecord>();

    const details = await batchedFetch(
      summaries,
      (summary: DivisionSummary) => fetchDivisionDetail(house, summary.id)
    );

    for (let i = 0; i < summaries.length; i++) {
      const detail = details[i];
      if (!detail) continue;
      const summary = summaries[i];

      const rebels =
        house === "Commons"
          ? detectCommonsRebels(detail as CommonsDivisionDetail)
          : detectLordsRebels(detail as LordsDivisionDetail);

      for (const rebel of rebels) {
        const existing = rebelMap.get(rebel.memberId);
        if (existing) {
          existing.count += 1;
          if (existing.recentDivisions.length < 2) {
            existing.recentDivisions.push(summary.title);
          }
        } else {
          rebelMap.set(rebel.memberId, {
            name: rebel.name,
            party: rebel.party,
            constituency: rebel.constituency,
            count: 1,
            recentDivisions: [summary.title],
          });
        }
      }
    }

    // Filter and sort
    let results = Array.from(rebelMap.entries()).map(([, record]) => record);

    if (partyFilter) {
      const lower = partyFilter.toLowerCase();
      results = results.filter((r) => r.party.toLowerCase().includes(lower));
    }

    results = results.filter((r) => r.count >= minRebellions);
    results.sort((a, b) => b.count - a.count);
    results = results.slice(0, limit);

    if (results.length === 0) {
      return `No rebels found matching the specified criteria across ${summaries.length} divisions scanned.`;
    }

    const lines: string[] = [];
    lines.push(
      `Rebellion Leaderboard — ${house} (from ${dateFrom})${partyFilter ? ` — ${partyFilter} only` : ""}`
    );
    lines.push("");

    results.forEach((r, i) => {
      lines.push(
        `${i + 1}. ${r.name} (${r.party}, ${r.constituency}) — ${r.count} rebellion${r.count !== 1 ? "s" : ""}`
      );
      if (r.recentDivisions.length > 0) {
        lines.push(
          `   e.g. "${r.recentDivisions[0]}"${r.recentDivisions[1] ? `, "${r.recentDivisions[1]}"` : ""}`
        );
      }
    });

    lines.push("");
    lines.push(
      `Scanned ${summaries.length} divisions. Increase max_divisions for more complete results.`
    );

    return lines.join("\n");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unknown error occurred.";
    throw new Error(message);
  }
}
