// query_entities tool — cross-dataset intersection queries

import { parliamentFetch, MEMBERS_API, batchedFetch } from "../api/client.js";
import {
  fetchDivisionDetail,
  detectCommonsRebels,
  detectLordsRebels,
  type CommonsDivisionDetail,
  type LordsDivisionDetail,
} from "./shared.js";

const INTERESTS_API = "https://interests-api.parliament.uk/api/v1";

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const queryTools = [
  {
    name: "query_entities",
    description:
      "Cross-dataset query: find MPs matching multiple conditions spanning vote records AND financial interests. Examples: 'Labour MPs who voted No on division 1234', 'MPs who rebelled in division 5678 AND have defence interests', 'MPs with fossil fuel interests who voted Aye'. Specify division_id with voted='aye'/'no' or rebellion_only=true for vote filter. Specify has_interest keyword for interest filter. Results are the intersection of all conditions.",
    inputSchema: {
      type: "object",
      properties: {
        division_id: {
          type: "number",
          description: "Division to filter votes by.",
        },
        voted: {
          type: "string",
          enum: ["aye", "no"],
          description: "Filter to only Aye or No voters in the division.",
        },
        rebellion_only: {
          type: "boolean",
          description:
            "If true, only include MPs who rebelled in the specified division.",
        },
        house: {
          type: "string",
          enum: ["Commons", "Lords"],
          description: "Which house. Defaults to Commons.",
        },
        has_interest: {
          type: "string",
          description:
            "Filter to MPs with a declared interest matching this keyword.",
        },
        party: {
          type: "string",
          description: "Filter to a specific party.",
        },
        limit: {
          type: "number",
          description: "Maximum results. Default 50.",
        },
      },
      required: [],
    },
  },
];

// ─── Internal Types ───────────────────────────────────────────────────────────

interface MPRecord {
  memberId: number;
  name: string;
  party: string;
  constituency: string;
  voteDirection: string | null;
  rebelled: boolean;
  interests: string[];
}

interface InterestItem {
  id: number;
  parentInterestId: number | null;
  summary: string;
  member: {
    id: number;
    name: string;
    party: string;
    constituency: string;
  };
}

interface InterestsResponse {
  items: InterestItem[];
  totalResults: number;
}

interface MemberResponse {
  value: {
    id: number;
    nameDisplayAs: string;
    latestParty: { name: string };
    latestHouseMembership: { membershipFrom: string; house: number };
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleQueryTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    if (name !== "query_entities") {
      throw new Error(`Unknown tool: ${name}`);
    }

    const divisionId = args.division_id as number | undefined;
    const voted = args.voted as "aye" | "no" | undefined;
    const rebellionOnly = (args.rebellion_only as boolean) ?? false;
    const house = (args.house as "Commons" | "Lords") ?? "Commons";
    const hasInterest = args.has_interest as string | undefined;
    const partyFilter = args.party as string | undefined;
    const limit = (args.limit as number) ?? 50;

    if (!divisionId && !hasInterest && !partyFilter) {
      return "At least one filter required: division_id, has_interest, or party.";
    }

    // ── Step 1: Build vote-based MP set ──────────────────────────────────────
    let mpSet: Map<number, MPRecord> | null = null;

    if (divisionId !== undefined) {
      const detail = await fetchDivisionDetail(house, divisionId);
      mpSet = new Map();

      if (house === "Commons") {
        const d = detail as CommonsDivisionDetail;
        const rebels = detectCommonsRebels(d);
        const rebelIds = new Set(rebels.map((r) => r.memberId));

        const allVoters: { voter: { MemberId: number; Name: string; Party: string; MemberFrom: string }; dir: string }[] = [
          ...d.Ayes.map((v) => ({ voter: v, dir: "Aye" })),
          ...d.Noes.map((v) => ({ voter: v, dir: "No" })),
        ];

        for (const { voter, dir } of allVoters) {
          // Apply vote direction filter
          if (voted === "aye" && dir !== "Aye") continue;
          if (voted === "no" && dir !== "No") continue;

          const rebelled = rebelIds.has(voter.MemberId);

          // Apply rebellion filter
          if (rebellionOnly && !rebelled) continue;

          mpSet.set(voter.MemberId, {
            memberId: voter.MemberId,
            name: voter.Name,
            party: voter.Party,
            constituency: voter.MemberFrom,
            voteDirection: dir,
            rebelled,
            interests: [],
          });
        }
      } else {
        // Lords
        const d = detail as LordsDivisionDetail;
        const rebels = detectLordsRebels(d);
        const rebelIds = new Set(rebels.map((r) => r.memberId));

        const allVoters: { voter: { memberId: number; name: string; party: string; memberFrom: string }; dir: string }[] = [
          ...d.contents.map((v) => ({ voter: v, dir: "Content" })),
          ...d.notContents.map((v) => ({ voter: v, dir: "NotContent" })),
        ];

        for (const { voter, dir } of allVoters) {
          if (voted === "aye" && dir !== "Content") continue;
          if (voted === "no" && dir !== "NotContent") continue;

          const rebelled = rebelIds.has(voter.memberId);
          if (rebellionOnly && !rebelled) continue;

          mpSet.set(voter.memberId, {
            memberId: voter.memberId,
            name: voter.name,
            party: voter.party,
            constituency: voter.memberFrom,
            voteDirection: dir,
            rebelled,
            interests: [],
          });
        }
      }
    }

    // ── Step 2: Apply party filter to vote-based set ──────────────────────────
    if (partyFilter && mpSet !== null) {
      const lower = partyFilter.toLowerCase();
      for (const [id, mp] of mpSet) {
        if (!mp.party.toLowerCase().includes(lower)) {
          mpSet.delete(id);
        }
      }
    }

    // ── Step 3: Interest filter ───────────────────────────────────────────────
    if (hasInterest) {
      const interestLower = hasInterest.toLowerCase();
      const categoryIds = [12, 8, 9];

      // Map of memberId → interest summaries
      const interestMap = new Map<number, { name: string; party: string; constituency: string; interests: string[] }>();

      async function fetchCategoryInterests(categoryId: number): Promise<InterestItem[]> {
        const allItems: InterestItem[] = [];
        let skip = 0;
        const pageSize = 20;

        while (true) {
          const data = (await parliamentFetch(`${INTERESTS_API}/Interests`, {
            CategoryId: categoryId,
            Take: pageSize,
            Skip: skip,
          })) as InterestsResponse;

          const items = data?.items ?? [];
          allItems.push(...items);

          if (items.length < pageSize || skip >= 500) break;
          skip += pageSize;
        }

        return allItems;
      }

      const categoryResults = await Promise.allSettled(
        categoryIds.map((id) => fetchCategoryInterests(id))
      );

      for (const result of categoryResults) {
        if (result.status !== "fulfilled") continue;
        for (const item of result.value) {
          if (
            item.parentInterestId === null &&
            item.summary?.toLowerCase().includes(interestLower)
          ) {
            const existing = interestMap.get(item.member.id);
            if (existing) {
              existing.interests.push(item.summary);
            } else {
              interestMap.set(item.member.id, {
                name: item.member.name,
                party: item.member.party,
                constituency: item.member.constituency,
                interests: [item.summary],
              });
            }
          }
        }
      }

      if (mpSet !== null) {
        // Intersection: remove MPs not in interest map, add interests to those who are
        for (const [id, mp] of mpSet) {
          const interestData = interestMap.get(id);
          if (!interestData) {
            mpSet.delete(id);
          } else {
            mp.interests = interestData.interests;
          }
        }
      } else {
        // Build mpSet from interest map
        mpSet = new Map();
        for (const [memberId, data] of interestMap) {
          mpSet.set(memberId, {
            memberId,
            name: data.name,
            party: data.party,
            constituency: data.constituency,
            voteDirection: null,
            rebelled: false,
            interests: data.interests,
          });
        }

        // Enrich with member details if small enough
        if (mpSet.size <= 50) {
          const memberEntries = Array.from(mpSet.entries());
          const memberDetails = await batchedFetch(
            memberEntries,
            ([memberId]) =>
              parliamentFetch(`${MEMBERS_API}/Members/${memberId}`) as Promise<MemberResponse>
          );
          for (let i = 0; i < memberEntries.length; i++) {
            const memberData = memberDetails[i];
            if (!memberData?.value) continue;
            const [, mp] = memberEntries[i];
            const v = memberData.value;
            mp.name = v.nameDisplayAs ?? mp.name;
            mp.party = v.latestParty?.name ?? mp.party;
            mp.constituency = v.latestHouseMembership?.membershipFrom ?? mp.constituency;
          }
        }
      }
    }

    // ── Step 4: Apply party filter to interest-sourced set ───────────────────
    if (partyFilter && mpSet !== null) {
      const lower = partyFilter.toLowerCase();
      for (const [id, mp] of mpSet) {
        if (!mp.party.toLowerCase().includes(lower)) {
          mpSet.delete(id);
        }
      }
    }

    // ── Step 5: Format output ─────────────────────────────────────────────────
    if (!mpSet || mpSet.size === 0) {
      return "No MPs found matching all the specified conditions.";
    }

    const results = Array.from(mpSet.values()).slice(0, limit);

    const conditions: string[] = [];
    if (divisionId !== undefined) {
      if (rebellionOnly) conditions.push(`rebelled in division ${divisionId}`);
      else if (voted) conditions.push(`voted ${voted.toUpperCase()} in division ${divisionId}`);
      else conditions.push(`voted in division ${divisionId}`);
    }
    if (hasInterest) conditions.push(`has interest: "${hasInterest}"`);
    if (partyFilter) conditions.push(`party: ${partyFilter}`);

    const lines: string[] = [];
    lines.push(`MPs matching: ${conditions.join(" AND ")}`);
    lines.push(`Found: ${mpSet.size}${mpSet.size > limit ? ` (showing first ${limit})` : ""}`);
    lines.push("");

    for (const mp of results) {
      let row = `• ${mp.name} (${mp.party}, ${mp.constituency}) | ID: ${mp.memberId}`;
      if (mp.voteDirection) {
        row += ` | Voted: ${mp.voteDirection}`;
        if (mp.rebelled) row += " [REBEL]";
      }
      lines.push(row);

      for (const interest of mp.interests.slice(0, 2)) {
        lines.push(`  Interest: ${interest}`);
      }
      if (mp.interests.length > 2) {
        lines.push(`  ... and ${mp.interests.length - 2} more interests`);
      }
    }

    return lines.join("\n");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unknown error occurred.";
    throw new Error(message);
  }
}
