# UK Parliament MCP Server
[![npm version](https://badge.fury.io/js/uk-parliament-mcp.svg)](https://badge.fury.io/js/uk-parliament-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-kupad95-blue)](https://github.com/kupad95/uk-parliament-mcp-server)

A **Model Context Protocol (MCP) server** for live UK Parliament data.
Query bills, votes, MP profiles, financial interests, and petitions straight from your MCP‑compatible assistant, no API key required.

---

## Features

- **No authentication** – open data under the Open Parliament Licence
- **Rebellion tracking** – detect MPs voting against their party whip
- **Cross-dataset queries** – match vote records against financial interests
- **Pattern detection** – close votes, government defeats, party rebellion rates
- **Bill & petition search** – by keyword, stage, or status

---

## Installation

```bash
# One‑off run
npx uk-parliament-mcp

# Global install
npm install -g uk-parliament-mcp
```

---

## Usage

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "uk-parliament": {
      "command": "npx",
      "args": ["-y", "uk-parliament-mcp"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add uk-parliament -- npx -y uk-parliament-mcp
```

---

## Available Tools

| Tool | Purpose |
|------|---------|
| `rank_entities` | Rank MPs by rebellion count across divisions |
| `get_events` | Recent divisions, rebellions, or bills |
| `analyze_patterns` | Close votes, government defeats, party rebellion rates |
| `find_entities` | Find MPs, bills, petitions, or declared interests |
| `query_entities` | Cross-reference vote records with financial interests |

---

## What You Can Ask

| Question | Tool |
|----------|------|
| Which Labour MPs have rebelled most this parliament? | `rank_entities` |
| What votes happened in the Commons this week? | `get_events` |
| Which Conservative MPs rebelled last month? | `get_events` |
| Bills currently about welfare reform? | `find_entities` |
| Show me knife-edge votes (10 votes margin or fewer) this year | `analyze_patterns` |
| Which government bills were defeated in the Lords? | `analyze_patterns` |
| MPs with declared defence company interests | `find_entities` |
| Labour MPs who voted No on a Renters Reform Bill with property interests | `query_entities` |
| What are the most-signed open petitions right now? | `find_entities` |

---

## Data Sources

| API | What it covers |
|-----|----------------|
| `bills-api.parliament.uk` | Bills, stages, sponsors |
| `commonsvotes-api.parliament.uk` | Commons division records |
| `lordsvotes-api.parliament.uk` | Lords division records |
| `members-api.parliament.uk` | MP and Lord profiles |
| `interests-api.parliament.uk` | Register of Members' Financial Interests |
| `petition.parliament.uk` | Petitions and signature counts |

---

## Development

```bash
git clone https://github.com/YOUR_USERNAME/uk-parliament-mcp-server.git
cd uk-parliament-mcp-server
npm install
npm run build   # compile TypeScript
npm start       # production
npm run dev     # watch & reload
```

---

## Contributing

1. Fork → branch → commit
2. `git push` and open a PR
3. Follow the coding style in **src/**

---

## License

MIT – see `LICENSE`.

---

> **Disclaimer**
> This project is unofficial and not endorsed by UK Parliament. Data usage is subject to the [Open Parliament Licence](https://www.parliament.uk/site-information/copyright-parliament/open-parliament-licence/).
