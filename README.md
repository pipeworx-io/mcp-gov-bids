# mcp-gov-bids

Gov Bids MCP — open & historical US government bid solicitations (Wave 4b, hosted).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `open_bids_search` | Find OPEN US government bid solicitations (RFPs/RFQs/IFBs) that vendors can currently respond to, from city & county procurement portals — updated daily. Filter by keyword (matches solicitation title/reference), jurisdiction, and closing window. Returns each opportunity with title, reference number, awarding jurisdiction, close date, and the URL to respond. By default returns OPEN bids sorted by soonest close date; set status to 'closed' or 'all' to search past solicitations too (we retain history). Use for 'what is <city/county> currently bidding out' or 'open RFPs for <keyword>'. This is LIVE OPEN BIDS (for awarded contracts use gov_contracts_search). |
| `gov_bids_jurisdictions` | List the US city & county procurement portals covered by open_bids_search, with each jurisdiction key, name, and current open-bid count. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "gov-bids": {
      "url": "https://gateway.pipeworx.io/gov-bids/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Gov Bids data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
