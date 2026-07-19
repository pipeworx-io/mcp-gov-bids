interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Gov Bids MCP — live OPEN government bid solicitations from Bonfire portals.
 *
 * US state/local bid portals have no sanctioned public API, but Bonfire (Euna),
 * the most common big-city/county bid platform, serves its public opportunity
 * list from an anonymous session endpoint that its own SPA calls:
 *   1. GET https://<portal>.bonfirehub.com/portal/  → sets `bonfirehub` session
 *      cookie + `XSRF-TOKEN` cookie.
 *   2. GET /PublicPortal/getOpenPublicOpportunitiesSectionData with those cookies
 *      + the XSRF token echoed as `X-XSRF-TOKEN` → JSON {payload:{projects:{...}}}.
 * No API key. This pack fronts that across a registry of Bonfire portals,
 * normalized, so an agent can find open bids by jurisdiction/keyword.
 *
 * Wave 4a (live-fetch). The hosted-history version (never-delete moat, gov-auction
 * pattern) is Wave 4b — see docs/us-procurement-build-plan.md.
 */


const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Bonfire portals (subdomain → display jurisdiction). Grows freely; every
// bonfirehub.com subdomain uses the identical endpoint. Seed = big verified ones.
const PORTALS: Array<{ key: string; sub: string; name: string }> = [
  { key: 'fort-worth-tx', sub: 'fortworthtexas', name: 'Fort Worth, TX' },
  { key: 'harris-county-tx', sub: 'harriscountytx', name: 'Harris County, TX' },
  { key: 'broward-county-fl', sub: 'broward', name: 'Broward County, FL' },
  { key: 'cook-county-il', sub: 'cookcountyil', name: 'Cook County, IL' },
  { key: 'clark-county-nv', sub: 'clarkcountynv', name: 'Clark County, NV' },
  { key: 'dallas-tx', sub: 'dallascityhall', name: 'Dallas, TX' },
];

const BY_KEY = new Map(PORTALS.map((p) => [p.key, p]));

const tools: McpToolExport['tools'] = [
  {
    name: 'open_bids_search',
    description:
      "Find OPEN government bid solicitations (RFPs/RFQs/IFBs) that vendors can currently respond to, from US city & county Bonfire procurement portals — live, keyless. Filter by keyword (matches the solicitation title) and/or a specific jurisdiction; omit jurisdiction to search all covered portals. Returns each open opportunity with its title, reference number, awarding jurisdiction, close date, and the URL to view/respond. Use this for 'what contracts is <city/county> currently bidding out' or 'open RFPs for <keyword>'. This is LIVE OPEN BIDS (for awarded/historical contracts use gov_contracts_search).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        jurisdiction: { type: 'string', description: 'Portal key to target (e.g. "fort-worth-tx", "harris-county-tx", "cook-county-il"). Omit to search all covered jurisdictions. Use gov_bids_jurisdictions to list keys.' },
        keyword: { type: 'string', description: 'Case-insensitive substring to match against the solicitation title, e.g. "construction", "audit", "software".' },
        limit: { type: ['number', 'string'], description: 'Max open bids per jurisdiction (default 25).' },
      },
    },
  },
  {
    name: 'gov_bids_jurisdictions',
    description:
      'List the US city & county Bonfire procurement portals covered by open_bids_search, with each portal key, jurisdiction name, and current live open-bid count.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

interface BonfireProject {
  ProjectID?: string;
  ReferenceID?: string;
  ProjectName?: string;
  DateClose?: string;
  ProjectStatusID?: string;
  DepartmentID?: string;
}

// Anonymous session handshake: fetch the portal page for the session +
// XSRF-TOKEN cookies, then call the section endpoint echoing the XSRF token.
async function fetchOpenProjects(sub: string): Promise<BonfireProject[]> {
  const base = `https://${sub}.bonfirehub.com`;
  const page = await fetch(`${base}/portal/`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!page.ok) throw new Error(`portal ${page.status}`);
  const setCookies: string[] =
    typeof (page.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (page.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : page.headers.get('set-cookie')
        ? [page.headers.get('set-cookie') as string]
        : [];
  const jar = setCookies.map((c) => c.split(';')[0]);
  const cookie = jar.join('; ');
  const xsrf = jar.find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '';
  const res = await fetch(`${base}/PublicPortal/getOpenPublicOpportunitiesSectionData`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookie,
      ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}),
    },
  });
  if (!res.ok) throw new Error(`opportunities ${res.status}`);
  const data = (await res.json()) as { success?: number; payload?: { projects?: Record<string, BonfireProject> } };
  if (!data.success || !data.payload?.projects) return [];
  return Object.values(data.payload.projects);
}

function normalize(p: BonfireProject, portal: { key: string; sub: string; name: string }): Record<string, unknown> {
  const id = p.ProjectID ?? '';
  return {
    jurisdiction: portal.key,
    jurisdiction_name: portal.name,
    title: p.ProjectName ?? null,
    reference: p.ReferenceID ?? null,
    close_date: p.DateClose ?? null,
    status: 'open',
    url: id ? `https://${portal.sub}.bonfirehub.com/opportunities/${id}` : `https://${portal.sub}.bonfirehub.com/portal/`,
    source: 'bonfire',
  };
}

async function openFor(portal: { key: string; sub: string; name: string }, keyword: string | undefined, limit: number): Promise<Record<string, unknown>[]> {
  let projects = await fetchOpenProjects(portal.sub);
  if (keyword) {
    const k = keyword.toLowerCase();
    projects = projects.filter((p) => (p.ProjectName ?? '').toLowerCase().includes(k));
  }
  return projects.slice(0, limit).map((p) => normalize(p, portal));
}

async function search(args: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
  const keyword = typeof args.keyword === 'string' && args.keyword.trim() ? args.keyword.trim() : undefined;
  const jurKey = typeof args.jurisdiction === 'string' && args.jurisdiction.trim() ? args.jurisdiction.trim().toLowerCase() : undefined;
  let targets = PORTALS;
  if (jurKey) {
    const p = BY_KEY.get(jurKey);
    if (!p) return { error: 'user_error', message: `Unknown jurisdiction "${jurKey}". Call gov_bids_jurisdictions for keys.` };
    targets = [p];
  }
  const settled = await Promise.allSettled(targets.map((p) => openFor(p, keyword, limit)));
  const bids: Record<string, unknown>[] = [];
  const errors: Record<string, string> = {};
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') bids.push(...s.value);
    else errors[targets[i].key] = s.reason instanceof Error ? s.reason.message : String(s.reason);
  });
  return {
    jurisdictions_searched: targets.map((p) => p.key),
    count: bids.length,
    open_bids: bids,
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}

async function jurisdictionsList(): Promise<unknown> {
  const rows = await Promise.all(
    PORTALS.map(async (p) => {
      let open_bids: number | null = null;
      try {
        open_bids = (await fetchOpenProjects(p.sub)).length;
      } catch {
        open_bids = null;
      }
      return { key: p.key, name: p.name, portal: `${p.sub}.bonfirehub.com`, open_bids };
    }),
  );
  return { count: rows.length, jurisdictions: rows };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'open_bids_search':
        return await search(args);
      case 'gov_bids_jurisdictions':
        return await jurisdictionsList();
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
