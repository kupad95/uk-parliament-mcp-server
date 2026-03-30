// get_events tool — recent parliamentary events

import {
  fetchDivisionSummaries,
  fetchDivisionDetail,
  detectCommonsRebels,
  detectLordsRebels,
  formatDate,
  daysAgoISO,
  fetchBillDetail,
  type CommonsDivisionDetail,
  type LordsDivisionDetail,
  type DivisionSummary,
} from "./shared.js";

import { parliamentFetch, BILLS_API, COMMONS_VOTES_API, MEMBERS_API, batchedFetch } from "../api/client.js";

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const eventsTools = [
  {
    name: "get_events",
    description:
      "Get recent parliamentary events: votes/divisions, party rebellions, bill stage changes, or a specific MP's voting record. " +
      "event_type='division': recent votes with pass/fail results. " +
      "event_type='rebellion': divisions with party rebels, optionally filtered by party. " +
      "event_type='bill': bills filtered by stage or keyword. " +
      "event_type='member_votes': full voting history for a specific MP — pass name='Nigel Farage' (or mp_id if already known). Shows each division, how the MP voted (Aye/No), and the result.",
    inputSchema: {
      type: "object",
      properties: {
        event_type: {
          type: "string",
          enum: ["division", "rebellion", "bill", "member_votes"],
          description: "The type of event to retrieve.",
        },
        house: {
          type: "string",
          enum: ["Commons", "Lords"],
          description: "Which house. Defaults to Commons for votes.",
        },
        party: {
          type: "string",
          description: "For event_type='rebellion', filter to this party's rebels.",
        },
        name: {
          type: "string",
          description: "For event_type='member_votes': the MP's name (e.g. 'Nigel Farage').",
        },
        mp_id: {
          type: "number",
          description: "For event_type='member_votes': the MP's member ID if already known.",
        },
        days: {
          type: "number",
          description: "How many days back to search. Default 30.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results. Default 20.",
        },
        stage: {
          type: "string",
          description: "For event_type='bill': firstreading, secondreading, committee, report, thirdreading, royalassent.",
        },
        keyword: {
          type: "string",
          description: "For event_type='bill', search bill titles by keyword.",
        },
      },
      required: ["event_type"],
    },
  },
];

// ─── Stage ID Mapping ─────────────────────────────────────────────────────────

const STAGE_IDS: Record<string, number[]> = {
  firstreading: [6, 1],
  secondreading: [7, 2],
  committee: [8, 3, 48, 49],
  report: [9, 4],
  thirdreading: [10, 5],
  royalassent: [11],
};

// ─── Bills API Response Types ─────────────────────────────────────────────────

interface BillSponsorMember {
  memberId: number;
  name: string;
  party: string;
}

interface BillSponsor {
  member: BillSponsorMember | null;
  organisation: { name: string } | null;
  isLead: boolean;
}

interface BillCurrentStage {
  description: string;
  house: string;
  lastUpdate: string;
}

interface BillItem {
  billId: number;
  shortTitle: string;
  currentHouse: string;
  lastUpdate: string;
  currentStage: BillCurrentStage | null;
  sponsors: BillSponsor[];
}

interface BillsResponse {
  items: BillItem[];
  totalResults: number;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleEventsTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    if (name !== "get_events") {
      throw new Error(`Unknown tool: ${name}`);
    }

    const eventType = args.event_type as string;
    const house = (args.house as "Commons" | "Lords") ?? "Commons";
    const days = (args.days as number) ?? 30;
    const limit = (args.limit as number) ?? 20;

    if (eventType === "division") {
      return await handleDivisionEvents(house, days, limit);
    } else if (eventType === "rebellion") {
      const party = args.party as string | undefined;
      return await handleRebellionEvents(house, days, limit, party);
    } else if (eventType === "bill") {
      const stage = args.stage as string | undefined;
      const keyword = args.keyword as string | undefined;
      return await handleBillEvents(house, limit, stage, keyword, args);
    } else if (eventType === "member_votes") {
      const memberName = args.name as string | undefined;
      const mpId = args.mp_id as number | undefined;
      return await handleMemberVotes(memberName, mpId, days, limit);
    } else {
      throw new Error(
        `Unknown event_type: ${eventType}. Use 'division', 'rebellion', 'bill', or 'member_votes'.`
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unknown error occurred.";
    throw new Error(message);
  }
}

async function handleDivisionEvents(
  house: "Commons" | "Lords",
  days: number,
  limit: number
): Promise<string> {
  const startDate = daysAgoISO(days);
  const summaries = await fetchDivisionSummaries(house, startDate, limit);

  if (summaries.length === 0) {
    return `No divisions found in the ${house} in the last ${days} days.`;
  }

  const lines: string[] = [];
  lines.push(`Recent Divisions — ${house} (last ${days} days)`);
  lines.push("");

  for (const div of summaries) {
    const yesLabel = house === "Commons" ? "Ayes" : "Contents";
    const noLabel = house === "Commons" ? "Noes" : "Not Contents";
    const passed = div.yesCount > div.noCount;
    const result = passed ? "PASSED" : "FAILED";
    lines.push(`• [${formatDate(div.date)}] ${div.title}`);
    lines.push(
      `  ID: ${div.id} | ${result} — ${yesLabel}: ${div.yesCount}, ${noLabel}: ${div.noCount}${div.isGovernmentWin !== undefined ? ` | Govt ${div.isGovernmentWin ? "won" : "lost"}` : ""}`
    );
  }

  return lines.join("\n");
}

async function handleRebellionEvents(
  house: "Commons" | "Lords",
  days: number,
  limit: number,
  party?: string
): Promise<string> {
  const startDate = daysAgoISO(days);
  const fetchCount = Math.min(limit * 3, 150);
  const summaries = await fetchDivisionSummaries(house, startDate, fetchCount);

  const details = await batchedFetch(
    summaries,
    (summary: DivisionSummary) => fetchDivisionDetail(house, summary.id)
  );

  const results: { title: string; date: string; id: number; rebels: { name: string; party: string }[] }[] = [];

  for (let i = 0; i < summaries.length; i++) {
    if (results.length >= limit) break;
    const detail = details[i];
    if (!detail) continue;
    const summary = summaries[i];

    let rebels =
      house === "Commons"
        ? detectCommonsRebels(detail as CommonsDivisionDetail)
        : detectLordsRebels(detail as LordsDivisionDetail);

    if (party) {
      const lower = party.toLowerCase();
      rebels = rebels.filter((r) => r.party.toLowerCase().includes(lower));
    }

    if (rebels.length > 0) {
      results.push({
        title: summary.title,
        date: summary.date,
        id: summary.id,
        rebels: rebels.map((r) => ({ name: r.name, party: r.party })),
      });
    }
  }

  if (results.length === 0) {
    return `No divisions with ${party ? `${party} ` : ""}rebels found in the ${house} in the last ${days} days.`;
  }

  const lines: string[] = [];
  lines.push(
    `Divisions with Party Rebels — ${house} (last ${days} days)${party ? ` — ${party} rebels` : ""}`
  );
  lines.push("");

  for (const r of results) {
    lines.push(`• [${formatDate(r.date)}] ${r.title} (ID: ${r.id})`);
    const shown = r.rebels.slice(0, 5);
    lines.push(
      `  Rebels: ${shown.map((rb) => `${rb.name} (${rb.party})`).join(", ")}${r.rebels.length > 5 ? ` +${r.rebels.length - 5} more` : ""}`
    );
  }

  return lines.join("\n");
}

async function handleBillEvents(
  house: "Commons" | "Lords" | undefined,
  limit: number,
  stage?: string,
  keyword?: string,
  args?: Record<string, unknown>
): Promise<string> {
  // Build URL with repeated BillStage params
  let url = `${BILLS_API}/Bills?Session=39&Take=${limit}`;

  if (stage) {
    const stageIds = STAGE_IDS[stage.toLowerCase()];
    if (stageIds) {
      for (const id of stageIds) {
        url += `&BillStage=${id}`;
      }
    }
  }

  if (keyword) {
    url += `&SearchTerm=${encodeURIComponent(keyword)}`;
  }

  if (house === "Commons") {
    url += "&CurrentHouse=1";
  } else if (house === "Lords") {
    url += "&CurrentHouse=2";
  }

  const data = (await parliamentFetch(url)) as BillsResponse;
  let items = data?.items ?? [];

  // Fallback: Bills API SearchTerm only matches short titles. If no results and a
  // keyword was given, search for each significant word individually, then filter
  // the combined candidates by checking all keyword words in short+long title.
  if (items.length === 0 && keyword) {
    const words = keyword.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const seen = new Set<number>();
    const candidates: BillItem[] = [];

    // Fetch all word searches in parallel
    const wordUrls = words.map((word) => {
      let wordUrl = `${BILLS_API}/Bills?Session=39&Take=30`;
      if (stage) {
        const stageIds = STAGE_IDS[stage.toLowerCase()];
        if (stageIds) {
          for (const id of stageIds) wordUrl += `&BillStage=${id}`;
        }
      }
      if (house === "Commons") wordUrl += "&CurrentHouse=1";
      else if (house === "Lords") wordUrl += "&CurrentHouse=2";
      wordUrl += `&SearchTerm=${encodeURIComponent(word)}`;
      return wordUrl;
    });

    const wordResults = await Promise.allSettled(
      wordUrls.map((u) => parliamentFetch(u) as Promise<BillsResponse>)
    );
    for (const res of wordResults) {
      if (res.status === "fulfilled") {
        for (const bill of res.value?.items ?? []) {
          if (!seen.has(bill.billId)) {
            seen.add(bill.billId);
            candidates.push(bill);
          }
        }
      }
    }

    const keywordWords = keyword.toLowerCase().split(/\s+/);
    type BillMatch = { bill: BillItem; detail: { sponsor: string; longTitle: string | null } };

    // Fetch all bill details in parallel
    const candidateSlice = candidates.slice(0, 30);
    const detailResults = await batchedFetch(
      candidateSlice,
      (bill: BillItem) => fetchBillDetail(bill.billId)
    );

    const matching: BillMatch[] = [];
    for (let i = 0; i < candidateSlice.length; i++) {
      const detail = detailResults[i];
      if (!detail) continue;
      const bill = candidateSlice[i];
      const combined = (bill.shortTitle + " " + (detail.longTitle ?? "")).toLowerCase();
      if (keywordWords.every((w) => combined.includes(w))) {
        matching.push({ bill, detail });
      }
    }

    if (matching.length === 0) {
      return `No bills found matching "${keyword}".`;
    }

    const lines: string[] = [];
    lines.push(`Bills matching "${keyword}": ${matching.length} found`);
    lines.push("");
    for (const { bill, detail } of matching) {
      const stageDesc = bill.currentStage?.description ?? "Unknown Stage";
      lines.push(`• ${bill.shortTitle} (ID: ${bill.billId})`);
      lines.push(
        `  Stage: ${stageDesc} | House: ${bill.currentHouse} | Last updated: ${formatDate(bill.lastUpdate)} | Lead sponsor: ${detail.sponsor}`
      );
      if (detail.longTitle) lines.push(`  Long title: ${detail.longTitle}`);
    }
    return lines.join("\n");
  }

  if (items.length === 0) {
    return `No bills found matching the specified criteria.`;
  }

  const lines: string[] = [];
  lines.push(
    `Bills${stage ? ` — ${stage}` : ""}${keyword ? ` matching "${keyword}"` : ""}${house ? ` in the ${house}` : ""}`
  );
  lines.push("");

  const billDetails = await batchedFetch(
    items,
    (bill: BillItem) => fetchBillDetail(bill.billId)
  );

  for (let i = 0; i < items.length; i++) {
    const bill = items[i];
    const detail = billDetails[i];
    const stageDesc = bill.currentStage?.description ?? "Unknown Stage";
    const currentHouse = bill.currentHouse ?? "Unknown";
    const lastUpdated = formatDate(bill.lastUpdate);

    lines.push(`• ${bill.shortTitle} (ID: ${bill.billId})`);
    lines.push(
      `  Stage: ${stageDesc} | House: ${currentHouse} | Last updated: ${lastUpdated} | Lead sponsor: ${detail?.sponsor ?? "Unknown"}`
    );
    if (detail?.longTitle) {
      lines.push(`  Long title: ${detail.longTitle}`);
    }
  }

  lines.push("");
  lines.push(`Total matching: ${data.totalResults ?? items.length}`);

  return lines.join("\n");
}

// ─── Member voting history types ──────────────────────────────────────────────

interface MemberSearchItem {
  value: {
    id: number;
    nameDisplayAs: string;
    latestParty: { name: string };
    latestHouseMembership: { house: number; membershipFrom: string };
  };
}

interface MemberSearchResponse {
  items: MemberSearchItem[];
}

interface MemberVoteDivision {
  DivisionId: number;
  Date: string;
  Title: string;
  AyeCount: number;
  NoCount: number;
  Ayes: { MemberId: number }[];
  Noes: { MemberId: number }[];
}

async function handleMemberVotes(
  memberName: string | undefined,
  mpId: number | undefined,
  days: number,
  limit: number
): Promise<string> {
  if (!memberName && !mpId) {
    throw new Error("Provide name or mp_id for event_type='member_votes'.");
  }

  // Resolve name → ID if needed
  let memberId = mpId;
  let displayName = memberName ?? `MP ${mpId}`;
  let party = "";
  let constituency = "";

  if (!memberId) {
    const data = (await parliamentFetch(`${MEMBERS_API}/Members/Search`, {
      Name: memberName,
      Take: 1,
    })) as MemberSearchResponse;
    const member = data?.items?.[0]?.value;
    if (!member) {
      return `No MP found matching "${memberName}".`;
    }
    memberId = member.id;
    displayName = member.nameDisplayAs;
    party = member.latestParty?.name ?? "";
    constituency = member.latestHouseMembership?.membershipFrom ?? "";
  }

  const startDate = daysAgoISO(days);
  const pageSize = 25;
  const summaries: MemberVoteDivision[] = [];
  let skip = 0;

  while (summaries.length < limit) {
    const take = Math.min(pageSize, limit - summaries.length);
    const data = (await parliamentFetch(
      `${COMMONS_VOTES_API}/divisions.json/search`,
      {
        "queryParameters.memberId": memberId,
        "queryParameters.startDate": startDate,
        "queryParameters.take": take,
        "queryParameters.skip": skip,
      }
    )) as MemberVoteDivision[];

    const items = Array.isArray(data) ? data : [];
    summaries.push(...items);
    if (items.length < take) break;
    skip += take;
  }

  if (summaries.length === 0) {
    return `No recorded votes found for ${displayName} in the last ${days} days.`;
  }

  // The search endpoint returns empty Ayes/Noes arrays — fetch each division
  // detail to determine how the member actually voted (Aye or No).
  const details = await batchedFetch(
    summaries,
    (div: MemberVoteDivision) =>
      parliamentFetch(`${COMMONS_VOTES_API}/division/${div.DivisionId}.json`) as Promise<MemberVoteDivision>
  );

  const lines: string[] = [];
  lines.push(
    `Voting record — ${displayName}${party ? ` (${party}` : ""}${constituency ? `, ${constituency}` : ""}${party ? ")" : ""} | Last ${days} days`
  );
  lines.push(`Divisions: ${summaries.length}`);
  lines.push("");

  for (let i = 0; i < summaries.length; i++) {
    const summary = summaries[i];
    const detail = details[i];
    const votedAye = detail?.Ayes?.some((v) => v.MemberId === memberId);
    const votedNo = detail?.Noes?.some((v) => v.MemberId === memberId);
    const vote = votedAye ? "AYE" : votedNo ? "NO" : "NOT RECORDED";
    const passed = summary.AyeCount > summary.NoCount ? "PASSED" : "FAILED";
    lines.push(`• [${formatDate(summary.Date)}] ${summary.Title}`);
    lines.push(
      `  Voted: ${vote} | Result: ${passed} (Ayes: ${summary.AyeCount}, Noes: ${summary.NoCount}) | ID: ${summary.DivisionId}`
    );
  }

  return lines.join("\n");
}
