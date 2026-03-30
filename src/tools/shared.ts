// Shared utilities for the analytical tool layer

import {
  parliamentFetch,
  COMMONS_VOTES_API,
  LORDS_VOTES_API,
  BILLS_API,
  delay,
} from "../api/client.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface DivisionSummary {
  id: number;
  title: string;
  date: string;
  yesCount: number;
  noCount: number;
  isGovernmentWin?: boolean;
}

export interface CommonsDivisionSummary {
  DivisionId: number;
  Date: string;
  Number: number;
  Title: string;
  AyeCount: number;
  NoCount: number;
}

export interface CommonsVoter {
  MemberId: number;
  Name: string;
  Party: string;
  MemberFrom: string;
  ListAs: string;
  ProxyName: string | null;
}

export interface CommonsDivisionDetail extends CommonsDivisionSummary {
  Ayes: CommonsVoter[];
  Noes: CommonsVoter[];
  AyeTellers: CommonsVoter[];
  NoTellers: CommonsVoter[];
}

export interface LordsDivisionSummary {
  divisionId: number;
  date: string;
  number: number;
  title: string;
  authoritativeContentCount: number;
  authoritativeNotContentCount: number;
  isGovernmentContent: boolean;
  isGovernmentWin: boolean;
}

export interface LordsVoter {
  memberId: number;
  name: string;
  memberFrom: string;
  party: string;
}

export interface LordsDivisionDetail extends LordsDivisionSummary {
  contents: LordsVoter[];
  notContents: LordsVoter[];
}

export interface Rebel {
  memberId: number;
  name: string;
  party: string;
  constituency: string;
  votedDirection: string;
  partyDirection: string;
}

// ─── Utility Functions ────────────────────────────────────────────────────────

export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "Unknown";
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return isoDate;
  return d.toISOString().slice(0, 10);
}

export function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function detectCommonsRebels(div: CommonsDivisionDetail): Rebel[] {
  // Build per-party vote counts
  const partyAyes = new Map<string, number>();
  const partyNoes = new Map<string, number>();

  for (const v of div.Ayes) {
    partyAyes.set(v.Party, (partyAyes.get(v.Party) ?? 0) + 1);
  }
  for (const v of div.Noes) {
    partyNoes.set(v.Party, (partyNoes.get(v.Party) ?? 0) + 1);
  }

  // Determine majority direction for each party
  const partyDirection = new Map<string, "Aye" | "No">();
  const allParties = new Set([...partyAyes.keys(), ...partyNoes.keys()]);
  for (const party of allParties) {
    const ayes = partyAyes.get(party) ?? 0;
    const noes = partyNoes.get(party) ?? 0;
    // Need at least 2 voters to detect a rebel
    if (ayes + noes < 2) continue;
    partyDirection.set(party, ayes >= noes ? "Aye" : "No");
  }

  const rebels: Rebel[] = [];

  // Aye voters whose party majority voted No
  for (const v of div.Ayes) {
    const dir = partyDirection.get(v.Party);
    if (dir === "No") {
      rebels.push({
        memberId: v.MemberId,
        name: v.Name,
        party: v.Party,
        constituency: v.MemberFrom,
        votedDirection: "Aye",
        partyDirection: "No",
      });
    }
  }

  // No voters whose party majority voted Aye
  for (const v of div.Noes) {
    const dir = partyDirection.get(v.Party);
    if (dir === "Aye") {
      rebels.push({
        memberId: v.MemberId,
        name: v.Name,
        party: v.Party,
        constituency: v.MemberFrom,
        votedDirection: "No",
        partyDirection: "Aye",
      });
    }
  }

  return rebels;
}

export function detectLordsRebels(div: LordsDivisionDetail): Rebel[] {
  const partyContents = new Map<string, number>();
  const partyNotContents = new Map<string, number>();

  for (const v of div.contents) {
    partyContents.set(v.party, (partyContents.get(v.party) ?? 0) + 1);
  }
  for (const v of div.notContents) {
    partyNotContents.set(v.party, (partyNotContents.get(v.party) ?? 0) + 1);
  }

  const partyDirection = new Map<string, "Content" | "NotContent">();
  const allParties = new Set([
    ...partyContents.keys(),
    ...partyNotContents.keys(),
  ]);
  for (const party of allParties) {
    const contents = partyContents.get(party) ?? 0;
    const notContents = partyNotContents.get(party) ?? 0;
    if (contents + notContents < 2) continue;
    partyDirection.set(
      party,
      contents >= notContents ? "Content" : "NotContent"
    );
  }

  const rebels: Rebel[] = [];

  for (const v of div.contents) {
    const dir = partyDirection.get(v.party);
    if (dir === "NotContent") {
      rebels.push({
        memberId: v.memberId,
        name: v.name,
        party: v.party,
        constituency: v.memberFrom,
        votedDirection: "Content",
        partyDirection: "NotContent",
      });
    }
  }

  for (const v of div.notContents) {
    const dir = partyDirection.get(v.party);
    if (dir === "Content") {
      rebels.push({
        memberId: v.memberId,
        name: v.name,
        party: v.party,
        constituency: v.memberFrom,
        votedDirection: "NotContent",
        partyDirection: "Content",
      });
    }
  }

  return rebels;
}

// The Commons and Lords Votes APIs cap `take` at 25 per request.
// This function paginates automatically to collect up to `count` summaries.
const VOTES_PAGE_SIZE = 25;

export async function fetchDivisionSummaries(
  house: "Commons" | "Lords",
  startDate: string,
  count: number
): Promise<DivisionSummary[]> {
  const results: DivisionSummary[] = [];
  let skip = 0;

  while (results.length < count) {
    const pageSize = Math.min(VOTES_PAGE_SIZE, count - results.length);

    if (house === "Commons") {
      const data = (await parliamentFetch(
        `${COMMONS_VOTES_API}/divisions.json/search`,
        {
          "queryParameters.startDate": startDate,
          "queryParameters.take": pageSize,
          "queryParameters.skip": skip,
        }
      )) as CommonsDivisionSummary[];
      const items = Array.isArray(data) ? data : [];
      results.push(
        ...items.map((d) => ({
          id: d.DivisionId,
          title: d.Title,
          date: d.Date,
          yesCount: d.AyeCount,
          noCount: d.NoCount,
        }))
      );
      if (items.length < pageSize) break; // no more pages
    } else {
      const data = (await parliamentFetch(
        `${LORDS_VOTES_API}/Divisions/search`,
        {
          "queryParameters.startDate": startDate,
          "queryParameters.take": pageSize,
          "queryParameters.skip": skip,
        }
      )) as LordsDivisionSummary[];
      const items = Array.isArray(data) ? data : [];
      results.push(
        ...items.map((d) => ({
          id: d.divisionId,
          title: d.title,
          date: d.date,
          yesCount: d.authoritativeContentCount,
          noCount: d.authoritativeNotContentCount,
          isGovernmentWin: d.isGovernmentWin,
        }))
      );
      if (items.length < pageSize) break; // no more pages
    }

    skip += pageSize;
  }

  return results.slice(0, count);
}

export async function fetchDivisionDetail(
  house: "Commons" | "Lords",
  divisionId: number
): Promise<CommonsDivisionDetail | LordsDivisionDetail> {
  if (house === "Commons") {
    return (await parliamentFetch(
      `${COMMONS_VOTES_API}/division/${divisionId}.json`
    )) as CommonsDivisionDetail;
  } else {
    return (await parliamentFetch(
      `${LORDS_VOTES_API}/Divisions/${divisionId}`
    )) as LordsDivisionDetail;
  }
}

// ─── Bill sponsor fetch ───────────────────────────────────────────────────────

interface BillDetailSponsor {
  member: { name: string } | null;
  organisation: { name: string } | null;
  sortOrder: number;
}

interface BillDetailResponse {
  // The /Bills/{id} endpoint returns fields at the top level (no .value wrapper)
  sponsors: BillDetailSponsor[];
  longTitle: string | null;
}

export interface BillDetail {
  sponsor: string;
  longTitle: string | null;
}

/**
 * Fetch sponsor and long title for a bill from the detail endpoint.
 * The list endpoint (/Bills) never includes sponsor or long title data.
 * Returns safe defaults silently on failure.
 */
export async function fetchBillDetail(billId: number): Promise<BillDetail> {
  try {
    const data = (await parliamentFetch(
      `${BILLS_API}/Bills/${billId}`
    )) as BillDetailResponse;
    const sponsors = data?.sponsors ?? [];
    const lead = sponsors.find((s) => s.sortOrder === 1) ?? sponsors[0];
    return {
      sponsor: lead?.member?.name ?? lead?.organisation?.name ?? "Unknown",
      longTitle: data?.longTitle ?? null,
    };
  } catch {
    return { sponsor: "Unknown", longTitle: null };
  }
}

// Re-export delay for convenience
export { delay };
