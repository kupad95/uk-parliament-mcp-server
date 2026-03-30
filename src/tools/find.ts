// find_entities tool — find MPs, bills, petitions, or financial interests

import { parliamentFetch, BILLS_API, MEMBERS_API, PETITIONS_API, batchedFetch } from "../api/client.js";
import { formatDate, fetchBillDetail } from "./shared.js";

const INTERESTS_API = "https://interests-api.parliament.uk/api/v1";

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const findTools = [
  {
    name: "find_entities",
    description:
      "Find MPs, bills, petitions, or declared financial interests. " +
      "entity_type='mp': search members by name/party/constituency/house/status. " +
      "entity_type='bill': search legislation by title keyword/stage/house. " +
      "entity_type='petition': find petitions by keyword. " +
      "entity_type='interest': fetch an MP's declared financial interests. Pass name='John McDonnell' OR mp_id=178 (member ID from a prior MP lookup). Optionally add keyword to filter by topic (e.g. keyword='property'). To find ALL MPs with a given interest topic, omit name/mp_id and pass only keyword='defence'.",
    inputSchema: {
      type: "object",
      properties: {
        entity_type: {
          type: "string",
          enum: ["mp", "bill", "petition", "interest"],
          description: "What to search for.",
        },
        name: {
          type: "string",
          description: "MP or Lord name. For entity_type='mp': filter by name. For entity_type='interest': fetch this specific MP's declared interests.",
        },
        mp_id: {
          type: "number",
          description: "MP member ID (integer). For entity_type='interest': fetch declared interests for the MP with this ID. Use this when you already have the member ID from a prior find_entities mp lookup.",
        },
        party: {
          type: "string",
          description: "Filter MPs by party.",
        },
        constituency: {
          type: "string",
          description: "Filter MPs by constituency.",
        },
        house: {
          type: "string",
          enum: ["Commons", "Lords"],
          description: "Filter by house.",
        },
        status: {
          type: "string",
          enum: ["active", "inactive"],
          description: "Filter MPs by active or inactive status.",
        },
        stage: {
          type: "string",
          description: "Bill stage filter.",
        },
        keyword: {
          type: "string",
          description:
            "Bill title search, petition text search, or financial interest topic filter.",
        },
        petition_state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Petition state filter. Default 'all'.",
        },
        limit: {
          type: "number",
          description: "Maximum results. Default 20.",
        },
      },
      required: ["entity_type"],
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

// ─── API Response Types ───────────────────────────────────────────────────────

interface MemberValue {
  id: number;
  nameDisplayAs: string;
  latestParty: { name: string };
  latestHouseMembership: {
    house: number;
    membershipFrom: string;
  };
}

interface MemberSearchItem {
  value: MemberValue;
}

interface MemberSearchResponse {
  items: MemberSearchItem[];
  totalResults: number;
}

interface BillSponsorMember {
  name: string;
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

interface PetitionAttributes {
  action: string;
  state: string;
  signature_count: number;
  opened_at: string;
  closed_at: string | null;
}

interface PetitionItem {
  id: string;
  attributes: PetitionAttributes;
}

interface PetitionsResponse {
  data: PetitionItem[];
  meta: { count: number };
}

interface InterestMember {
  id: number;
  name: string;
  party: string;
  constituency: string;
}

interface InterestItem {
  id: number;
  parentInterestId: number | null;
  summary: string;
  categoryId: number;
  categoryName: string;
  member: InterestMember;
}

interface InterestsResponse {
  items: InterestItem[];
  totalResults: number;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleFindTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    if (name !== "find_entities") {
      throw new Error(`Unknown tool: ${name}`);
    }

    const entityType = args.entity_type as string;
    const limit = (args.limit as number) ?? 20;

    if (entityType === "mp") {
      return await findMPs(args, limit);
    } else if (entityType === "bill") {
      return await findBills(args, limit);
    } else if (entityType === "petition") {
      return await findPetitions(args, limit);
    } else if (entityType === "interest") {
      return await findInterests(args, limit);
    } else {
      throw new Error(
        `Unknown entity_type: ${entityType}. Use 'mp', 'bill', 'petition', or 'interest'.`
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unknown error occurred.";
    throw new Error(message);
  }
}

async function findMPs(
  args: Record<string, unknown>,
  limit: number
): Promise<string> {
  const params: Record<string, string | number | boolean | undefined | null> = {
    Take: limit,
  };

  if (args.name) params.Name = args.name as string;
  if (args.party) params.Party = args.party as string;
  if (args.constituency) params.Constituency = args.constituency as string;

  if (args.house === "Commons") params.House = 1;
  else if (args.house === "Lords") params.House = 2;

  if (args.status === "active") params.IsCurrentMember = true;
  else if (args.status === "inactive") params.IsCurrentMember = false;

  const data = (await parliamentFetch(
    `${MEMBERS_API}/Members/Search`,
    params
  )) as MemberSearchResponse;

  const items = data?.items ?? [];

  if (items.length === 0) {
    return "No members found matching the specified criteria.";
  }

  const lines: string[] = [];
  lines.push(
    `Members found: ${data.totalResults ?? items.length}${items.length < (data.totalResults ?? 0) ? ` (showing first ${items.length})` : ""}`
  );
  lines.push("");

  for (const item of items) {
    const v = item.value;
    const houseName = v.latestHouseMembership?.house === 1 ? "Commons" : "Lords";
    const constituency = v.latestHouseMembership?.membershipFrom ?? "Unknown";
    lines.push(
      `• ${v.nameDisplayAs} (${v.latestParty?.name ?? "Unknown"}, ${houseName}) — ${constituency} | ID: ${v.id}`
    );
  }

  return lines.join("\n");
}

async function findBills(
  args: Record<string, unknown>,
  limit: number
): Promise<string> {
  const house = args.house as "Commons" | "Lords" | undefined;
  const stage = args.stage as string | undefined;
  const keyword = args.keyword as string | undefined;

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

  if (house === "Commons") url += "&CurrentHouse=1";
  else if (house === "Lords") url += "&CurrentHouse=2";

  const data = (await parliamentFetch(url)) as BillsResponse;
  let items = data?.items ?? [];

  // Fallback: Bills API SearchTerm only matches short titles. If no results and a
  // keyword was given, search for each significant word individually, then filter
  // the combined candidates by checking whether all keyword words appear anywhere
  // in the short title + long title combined.
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

    // Filter: all keyword words must appear as substrings in short+long title
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
        `  Stage: ${stageDesc} | House: ${bill.currentHouse} | Updated: ${formatDate(bill.lastUpdate)} | Lead: ${detail.sponsor}`
      );
      if (detail.longTitle) lines.push(`  Long title: ${detail.longTitle}`);
    }
    return lines.join("\n");
  }

  if (items.length === 0) {
    return "No bills found matching the specified criteria.";
  }

  const lines: string[] = [];
  lines.push(
    `Bills${stage ? ` at ${stage}` : ""}${keyword ? ` matching "${keyword}"` : ""}${house ? ` in ${house}` : ""}: ${data.totalResults ?? items.length} total`
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
    const lastUpdated = formatDate(bill.lastUpdate);

    lines.push(`• ${bill.shortTitle} (ID: ${bill.billId})`);
    lines.push(
      `  Stage: ${stageDesc} | House: ${bill.currentHouse} | Updated: ${lastUpdated} | Lead: ${detail?.sponsor ?? "Unknown"}`
    );
    if (detail?.longTitle) {
      lines.push(`  Long title: ${detail.longTitle}`);
    }
  }

  return lines.join("\n");
}

async function findPetitions(
  args: Record<string, unknown>,
  limit: number
): Promise<string> {
  const keyword = args.keyword as string | undefined;
  const petitionState = (args.petition_state as string) ?? "all";

  const params: Record<string, string | number | boolean | undefined | null> = {
    count: limit,
  };

  if (keyword) params.q = keyword;
  if (petitionState !== "all") params.state = petitionState;

  const data = (await parliamentFetch(
    `${PETITIONS_API}/petitions.json`,
    params
  )) as PetitionsResponse;

  const items = data?.data ?? [];

  if (items.length === 0) {
    return `No petitions found${keyword ? ` matching "${keyword}"` : ""}.`;
  }

  const lines: string[] = [];
  lines.push(
    `Petitions${keyword ? ` matching "${keyword}"` : ""}${petitionState !== "all" ? ` (${petitionState})` : ""}: ${data.meta?.count ?? items.length} total`
  );
  lines.push("");

  for (const p of items) {
    const attr = p.attributes;
    const state = attr.state ?? "unknown";
    const signatures = attr.signature_count?.toLocaleString() ?? "0";
    lines.push(`• ${attr.action}`);
    lines.push(
      `  ID: ${p.id} | Signatures: ${signatures} | State: ${state} | Opened: ${formatDate(attr.opened_at)}${attr.closed_at ? ` | Closed: ${formatDate(attr.closed_at)}` : ""}`
    );
  }

  return lines.join("\n");
}

async function findInterests(
  args: Record<string, unknown>,
  limit: number
): Promise<string> {
  const keyword = args.keyword as string | undefined;
  const name = args.name as string | undefined;
  const mpId = args.mp_id as number | undefined;

  // Direct ID lookup — skip member resolution entirely
  if (mpId) {
    const memberData = (await parliamentFetch(`${MEMBERS_API}/Members/${mpId}`)) as { value: MemberValue };
    const member = memberData?.value;
    if (!member) {
      return `No MP found with ID ${mpId}.`;
    }
    return await fetchMemberInterests(member, keyword, limit);
  }

  // Name-based lookup
  if (name) {
    return await findInterestsByMember(name, keyword, limit);
  }

  if (!keyword) {
    throw new Error(
      "Provide name='MP name', mp_id=<member ID>, or keyword='topic' to search financial interests."
    );
  }

  const lower = keyword.toLowerCase();
  // All 12 interest categories
  const categoryIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  // Fetch all pages for each category concurrently, then merge
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

  // Collect matching interests, deduplicated by member ID
  const memberMap = new Map<number, { name: string; party: string; constituency: string; interests: string[]; categoryName: string }>();
  const seen = new Set<number>();

  for (const result of categoryResults) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value) {
      if (memberMap.size >= limit) break;
      if (
        item.parentInterestId === null &&
        item.summary?.toLowerCase().includes(lower) &&
        !seen.has(item.member?.id)
      ) {
        seen.add(item.member.id);
        const existing = memberMap.get(item.member.id);
        if (existing) {
          existing.interests.push(item.summary);
        } else {
          memberMap.set(item.member.id, {
            name: item.member.name,
            party: item.member.party,
            constituency: item.member.constituency,
            interests: [item.summary],
            categoryName: item.categoryName,
          });
        }
      }
    }
    if (memberMap.size >= limit) break;
  }

  if (memberMap.size === 0) {
    return `No members found with declared interests matching "${keyword}".`;
  }

  const results = Array.from(memberMap.entries()).slice(0, limit);

  const lines: string[] = [];
  lines.push(`Members with interests matching "${keyword}": ${memberMap.size} found`);
  lines.push("");

  for (const [memberId, m] of results) {
    lines.push(`• ${m.name} (${m.party}, ${m.constituency}) | ID: ${memberId}`);
    for (const interest of m.interests.slice(0, 2)) {
      lines.push(`  Interest: ${interest}`);
    }
    if (m.interests.length > 2) {
      lines.push(`  ... and ${m.interests.length - 2} more interests`);
    }
  }

  return lines.join("\n");
}

async function findInterestsByMember(
  name: string,
  keyword: string | undefined,
  limit: number
): Promise<string> {
  // Step 1: resolve MP name → member ID
  const memberData = (await parliamentFetch(`${MEMBERS_API}/Members/Search`, {
    Name: name,
    Take: 1,
    IsCurrentMember: true,
  })) as MemberSearchResponse;

  const member = memberData?.items?.[0]?.value;

  if (!member) {
    // Retry without IsCurrentMember in case they're a former MP
    const retryData = (await parliamentFetch(`${MEMBERS_API}/Members/Search`, {
      Name: name,
      Take: 1,
    })) as MemberSearchResponse;
    const retryMember = retryData?.items?.[0]?.value;
    if (!retryMember) {
      return `No MP or Lord found matching "${name}".`;
    }
    return await fetchMemberInterests(retryMember, keyword, limit);
  }

  return await fetchMemberInterests(member, keyword, limit);
}

async function fetchMemberInterests(
  member: MemberValue,
  keyword: string | undefined,
  limit: number
): Promise<string> {
  const lower = keyword?.toLowerCase();

  // Fetch ALL interests for this member without category filter
  const allInterests: InterestItem[] = [];
  let skip = 0;
  const pageSize = 50;

  while (true) {
    const data = (await parliamentFetch(`${INTERESTS_API}/Interests`, {
      MemberId: member.id,
      Take: pageSize,
      Skip: skip,
    })) as InterestsResponse;

    const items = data?.items ?? [];
    allInterests.push(...items);

    if (items.length < pageSize || skip >= 500) break;
    skip += pageSize;
  }

  // Only top-level entries (no sub-items)
  const topLevel = allInterests.filter((i) => i.parentInterestId === null);

  // Optional keyword filter
  const filtered = lower
    ? topLevel.filter((i) => i.summary?.toLowerCase().includes(lower))
    : topLevel;

  const houseName = member.latestHouseMembership?.house === 1 ? "Commons" : "Lords";
  const constituency = member.latestHouseMembership?.membershipFrom ?? "Unknown";

  if (filtered.length === 0) {
    const noKeyword = keyword ? ` matching "${keyword}"` : "";
    return `No declared interests found for ${member.nameDisplayAs}${noKeyword}.\n\nMP profile: ${member.nameDisplayAs} (${member.latestParty?.name ?? "Unknown"}, ${houseName}) — ${constituency} | ID: ${member.id}`;
  }

  const lines: string[] = [];
  lines.push(
    `Declared interests for ${member.nameDisplayAs} (${member.latestParty?.name ?? "Unknown"}, ${houseName} — ${constituency}):${keyword ? ` filtered by "${keyword}"` : ""}`
  );
  lines.push(`Total: ${filtered.length} entries`);
  lines.push("");

  // Group by category
  const byCategory = new Map<string, InterestItem[]>();
  for (const item of filtered.slice(0, limit)) {
    const cat = item.categoryName ?? "Uncategorised";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(item);
  }

  for (const [cat, items] of byCategory) {
    lines.push(`${cat}:`);
    for (const item of items) {
      lines.push(`  • ${item.summary}`);
    }
    lines.push("");
  }

  if (filtered.length > limit) {
    lines.push(`(Showing first ${limit} of ${filtered.length} entries)`);
  }

  return lines.join("\n").trimEnd();
}
