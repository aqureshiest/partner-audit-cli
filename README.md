# partner-audit-cli

Standalone partner compliance audit — no BrowserBase, no Redis, no Next.js. Runs locally using your real Chrome browser.

## Setup

```bash
npm install
cp .env.example .env
# Fill in AWS_BEARER_TOKEN_BEDROCK and point the CSV paths to your downloaded sheets
```

### Prepare the CSV files

Download two tabs from the Google Sheet as CSV:

| Sheet tab | Save as |
|---|---|
| **Audit Links** | `partner-links.csv` |
| **ComplianceRules** | `compliance-rules.csv` |

Place them in the project root (or set `PARTNER_CSV` / `COMPLIANCE_RULES_CSV` to custom paths).

## Usage

```bash
# Audit all partners, all loan types
npm run audit

# Single partner
npm run audit -- --partner "SoFi"

# Filter by loan type (SLR, SLO, PL)
npm run audit -- --type SLR

# Export results to CSV
npm run audit -- --output csv

# Combine filters
npm run audit -- --partner "College Investor" --type SLR --output csv
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AWS_BEARER_TOKEN_BEDROCK` | Yes | Bearer token for AWS Bedrock |
| `AWS_REGION` | No | AWS region (default: `us-east-1`) |
| `PARTNER_CSV` | No | Path to partner links CSV (default: `./partner-links.csv`) |
| `COMPLIANCE_RULES_CSV` | No | Path to compliance rules CSV (default: `./compliance-rules.csv`) |
| `CHROME_PATH` | No | Path to Chrome binary (auto-detected if omitted) |
| `HEADLESS` | No | Set `false` to watch the browser scrape (default: `true`) |

## How it works

1. Loads partner URLs and compliance rules from local CSV files
2. Fetches current official rates from `connect.earnest.com`
3. Scrapes each partner page with local Chrome (real fingerprint, your cookies — no bot detection)
4. Sends content to Claude Haiku via AWS Bedrock for compliance analysis against the rules
5. Prints a per-partner report and optionally writes a CSV
