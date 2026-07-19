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
 * Gov Bids MCP — open & historical US government bid solicitations (Wave 4b, hosted).
 *
 * Reads the Pipeworx-hosted `procurement_bids` table (Supabase), populated daily
 * by the bonfire-sync Edge Function from Bonfire (Euna) city/county portals — the
 * most common US public bid platform, whose live open-opportunity list has no
 * sanctioned API. The moat: we never delete — when a bid drops off the source's
 * open list we flip it to 'closed' and keep it, so the history of what each
 * jurisdiction bids out accumulates (nobody else keeps this).
 *
 * Stateless/keyless for callers; the gateway injects _supabaseUrl/_supabaseKey.
 */


type Cfg = { url: string; key: string };

const tools: McpToolExport['tools'] = [
  {
    name: 'open_bids_search',
    description:
      "Find OPEN US government bid solicitations (RFPs/RFQs/IFBs) that vendors can currently respond to, from city & county procurement portals — updated daily. Filter by keyword (matches solicitation title/reference), jurisdiction, and closing window. Returns each opportunity with title, reference number, awarding jurisdiction, close date, and the URL to respond. By default returns OPEN bids sorted by soonest close date; set status to 'closed' or 'all' to search past solicitations too (we retain history). Use for 'what is <city/county> currently bidding out' or 'open RFPs for <keyword>'. This is LIVE OPEN BIDS (for awarded contracts use gov_contracts_search).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        jurisdiction: { type: 'string', description: 'Jurisdiction key to target (e.g. "fort-worth-tx", "harris-county-tx", "cook-county-il"). Omit for all covered jurisdictions. Use gov_bids_jurisdictions to list keys.' },
        keyword: { type: 'string', description: 'Case-insensitive substring matched against the solicitation title/reference, e.g. "construction", "audit", "software".' },
        closing_within_days: { type: ['number', 'string'], description: 'Only OPEN bids closing within this many days from now.' },
        status: { type: 'string', enum: ['open', 'closed', 'all'], description: "Bid status (default 'open'). 'closed' / 'all' search retained history." },
        limit: { type: ['number', 'string'], description: 'Max bids (default 25, max 100).' },
      },
    },
  },
  {
    name: 'gov_bids_jurisdictions',
    description:
      'List the US city & county procurement portals covered by open_bids_search, with each jurisdiction key, name, and current open-bid count.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

async function pg(cfg: Cfg, path: string, extraHeaders?: Record<string, string>): Promise<Response> {
  return fetch(`${cfg.url}/rest/v1/${path}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, ...(extraHeaders ?? {}) },
  });
}

function esc(s: string): string {
  // PostgREST ilike value: escape commas/parens that would break the filter.
  return s.replace(/[(),]/g, ' ');
}

function shape(r: Record<string, unknown>): Record<string, unknown> {
  return {
    jurisdiction: r.jurisdiction_key,
    jurisdiction_name: r.jurisdiction,
    title: r.title ?? null,
    reference: r.reference ?? null,
    close_date: r.close_date ?? null,
    status: r.status,
    url: r.url ?? null,
    source: r.source,
  };
}

async function search(cfg: Cfg, args: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
  const status = typeof args.status === 'string' && ['open', 'closed', 'all'].includes(args.status) ? args.status : 'open';
  const q: string[] = ['select=jurisdiction_key,jurisdiction,title,reference,close_date,status,url,source'];
  if (status !== 'all') q.push(`status=eq.${status}`);
  const jur = typeof args.jurisdiction === 'string' && args.jurisdiction.trim() ? args.jurisdiction.trim().toLowerCase() : undefined;
  if (jur) q.push(`jurisdiction_key=eq.${encodeURIComponent(jur)}`);
  const kw = typeof args.keyword === 'string' && args.keyword.trim() ? args.keyword.trim().toLowerCase() : undefined;
  if (kw) q.push(`search_blob=ilike.*${encodeURIComponent(esc(kw))}*`);
  const within = Number(args.closing_within_days);
  if (Number.isFinite(within) && within > 0) {
    const until = new Date(Date.now() + within * 86400_000).toISOString();
    q.push(`close_date=lte.${encodeURIComponent(until)}`, 'close_date=gte.now()');
  }
  q.push('order=close_date.asc.nullslast', `limit=${limit}`);
  const res = await pg(cfg, `procurement_bids?${q.join('&')}`);
  if (!res.ok) throw new Error(`bids store: ${res.status} ${(await res.text()).slice(0, 150)}`);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return { status, count: rows.length, open_bids: rows.map(shape) };
}

async function jurisdictionsList(cfg: Cfg): Promise<unknown> {
  // Distinct jurisdictions + open count. PostgREST group-by isn't available
  // without an RPC, so pull open rows' jurisdiction fields (bounded) and tally.
  const res = await pg(cfg, 'procurement_bids?select=jurisdiction_key,jurisdiction&status=eq.open&limit=5000');
  if (!res.ok) throw new Error(`bids store: ${res.status}`);
  const rows = (await res.json()) as Array<{ jurisdiction_key: string; jurisdiction: string }>;
  const counts = new Map<string, { name: string; open_bids: number }>();
  for (const r of rows) {
    const e = counts.get(r.jurisdiction_key) ?? { name: r.jurisdiction, open_bids: 0 };
    e.open_bids++;
    counts.set(r.jurisdiction_key, e);
  }
  const jurisdictions = [...counts.entries()]
    .map(([key, v]) => ({ key, name: v.name, open_bids: v.open_bids }))
    .sort((a, b) => b.open_bids - a.open_bids);
  return { count: jurisdictions.length, jurisdictions };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) return { error: 'gov-bids requires platform Supabase credentials (operator-configured).' };
  const cfg: Cfg = { url, key };
  try {
    switch (name) {
      case 'open_bids_search':
        return await search(cfg, args);
      case 'gov_bids_jurisdictions':
        return await jurisdictionsList(cfg);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
