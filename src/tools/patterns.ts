// analyze_patterns tool — detect patterns across many parliamentary votes

import {
  fetchDivisionSummaries,
  fetchDivisionDetail,
  detectCommonsRebels,
  detectLordsRebels,
  formatDate,
  daysAgoISO,
  type DivisionSummary,
  type CommonsDivisionDetail,
  type LordsDivisionDetail,
} from "./shared.js";
import { batchedFetch } from "../api/client.js";

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const patternsTools = [
  {
    name: "analyze_patterns",
    description:
      "Detect patterns across many parliamentary votes: 'close_votes' finds divisions with a small margin (near-misses or knife-edge votes), 'government_defeats' finds votes the government lost, 'party_rebellion_rate' shows which parties rebel most by percentage of votes cast. Use for trend analysis across many divisions.",
    inputSchema: {
      type: "object",
      properties: {
        pattern_type: {
          type: "string",
          enum: ["close_votes", "government_defeats", "party_rebellion_rate"],
          description: "The pattern to detect.",
        },
        house: {
          type: "string",
          enum: ["Commons", "Lords"],
          description: "Which house to analyse. Defaults to Commons.",
        },
        days: {
          type: "number",
          description: "How many days back to scan. Default 365.",
        },
        threshold: {
          type: "number",
          description:
            "For close_votes: maximum majority to count as close. Default 10.",
        },
        max_divisions: {
          type: "number",
          description: "Maximum divisions to scan. Default 100.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return. Default 20.",
        },
      },
      required: ["pattern_type"],
    },
  },
];

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handlePatternsTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    if (name !== "analyze_patterns") {
      throw new Error(`Unknown tool: ${name}`);
    }

    const patternType = args.pattern_type as string;
    const house = (args.house as "Commons" | "Lords") ?? "Commons";
    const days = (args.days as number) ?? 365;
    const maxDivisions = (args.max_divisions as number) ?? 100;
    const limit = (args.limit as number) ?? 20;

    const startDate = daysAgoISO(days);
    const summaries = await fetchDivisionSummaries(house, startDate, maxDivisions);

    if (patternType === "close_votes") {
      return handleCloseVotes(summaries, house, days, limit, args);
    } else if (patternType === "government_defeats") {
      return handleGovernmentDefeats(summaries, house, days, limit);
    } else if (patternType === "party_rebellion_rate") {
      return await handlePartyRebellionRate(summaries, house, days, limit);
    } else {
      throw new Error(
        `Unknown pattern_type: ${patternType}. Use 'close_votes', 'government_defeats', or 'party_rebellion_rate'.`
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unknown error occurred.";
    throw new Error(message);
  }
}

function handleCloseVotes(
  summaries: DivisionSummary[],
  house: string,
  days: number,
  limit: number,
  args: Record<string, unknown>
): string {
  const threshold = (args.threshold as number) ?? 10;

  const close = summaries
    .map((d) => ({ ...d, margin: Math.abs(d.yesCount - d.noCount) }))
    .filter((d) => d.margin <= threshold)
    .sort((a, b) => a.margin - b.margin)
    .slice(0, limit);

  if (close.length === 0) {
    return `No close votes (margin ≤ ${threshold}) found in the ${house} in the last ${days} days.`;
  }

  const yesLabel = house === "Commons" ? "Ayes" : "Contents";
  const noLabel = house === "Commons" ? "Noes" : "Not Contents";

  const lines: string[] = [];
  lines.push(
    `Close Votes (margin ≤ ${threshold}) — ${house} (last ${days} days, ${summaries.length} divisions scanned)`
  );
  lines.push("");

  for (const d of close) {
    const passed = d.yesCount > d.noCount;
    lines.push(`• [${formatDate(d.date)}] ${d.title} (ID: ${d.id})`);
    lines.push(
      `  Margin: ${d.margin} | ${passed ? "PASSED" : "FAILED"} — ${yesLabel}: ${d.yesCount}, ${noLabel}: ${d.noCount}`
    );
  }

  return lines.join("\n");
}

function handleGovernmentDefeats(
  summaries: DivisionSummary[],
  house: string,
  days: number,
  limit: number
): string {
  // Noes > Ayes means the motion fell (government typically moves the motion)
  const defeats = summaries
    .filter((d) => d.noCount > d.yesCount)
    .slice(0, limit);

  if (defeats.length === 0) {
    return `No government defeats found in the ${house} in the last ${days} days.`;
  }

  const yesLabel = house === "Commons" ? "Ayes" : "Contents";
  const noLabel = house === "Commons" ? "Noes" : "Not Contents";

  const lines: string[] = [];
  lines.push(`Government Defeats — ${house} (last ${days} days)`);
  lines.push("");

  for (const d of defeats) {
    const margin = d.noCount - d.yesCount;
    lines.push(`• [${formatDate(d.date)}] ${d.title} (ID: ${d.id})`);
    lines.push(
      `  Margin: ${margin} | ${yesLabel}: ${d.yesCount}, ${noLabel}: ${d.noCount}`
    );
  }

  lines.push("");
  lines.push(
    "Note: opposition day motions where government votes No intentionally are included — verify individual votes."
  );

  return lines.join("\n");
}

async function handlePartyRebellionRate(
  summaries: DivisionSummary[],
  house: string,
  days: number,
  limit: number
): Promise<string> {
  interface PartyStats {
    total_votes: number;
    rebel_votes: number;
  }
  const partyStats = new Map<string, PartyStats>();

  const details = await batchedFetch(
    summaries,
    (summary: DivisionSummary) => fetchDivisionDetail(house as "Commons" | "Lords", summary.id)
  );

  for (let i = 0; i < summaries.length; i++) {
    const detail = details[i];
    if (!detail) continue;

    if (house === "Commons") {
      const d = detail as CommonsDivisionDetail;
      const rebels = detectCommonsRebels(d);
      const rebelIds = new Set(rebels.map((r) => r.memberId));

      for (const voter of [...d.Ayes, ...d.Noes]) {
        const stats = partyStats.get(voter.Party) ?? { total_votes: 0, rebel_votes: 0 };
        stats.total_votes += 1;
        if (rebelIds.has(voter.MemberId)) {
          stats.rebel_votes += 1;
        }
        partyStats.set(voter.Party, stats);
      }
    } else {
      const d = detail as LordsDivisionDetail;
      const rebels = detectLordsRebels(d);
      const rebelIds = new Set(rebels.map((r) => r.memberId));

      for (const voter of [...d.contents, ...d.notContents]) {
        const stats = partyStats.get(voter.party) ?? { total_votes: 0, rebel_votes: 0 };
        stats.total_votes += 1;
        if (rebelIds.has(voter.memberId)) {
          stats.rebel_votes += 1;
        }
        partyStats.set(voter.party, stats);
      }
    }
  }

  // Filter parties with < 10 total votes and sort by rate
  const partyResults = Array.from(partyStats.entries())
    .filter(([, s]) => s.total_votes >= 10)
    .map(([party, s]) => ({
      party,
      total_votes: s.total_votes,
      rebel_votes: s.rebel_votes,
      rate: s.total_votes > 0 ? (s.rebel_votes / s.total_votes) * 100 : 0,
    }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, limit);

  if (partyResults.length === 0) {
    return `No sufficient party voting data found in the ${house} in the last ${days} days.`;
  }

  const lines: string[] = [];
  lines.push(
    `Party Rebellion Rate — ${house} (last ${days} days, ${summaries.length} divisions scanned)`
  );
  lines.push("");

  for (const p of partyResults) {
    lines.push(
      `• ${p.party}: ${p.rate.toFixed(1)}% rebellion rate (${p.rebel_votes} rebels / ${p.total_votes} total votes)`
    );
  }

  return lines.join("\n");
}
