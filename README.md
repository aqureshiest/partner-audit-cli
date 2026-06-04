# partner-audit-cli

Standalone partner compliance audit — no BrowserBase, no Redis, no Next.js. Runs locally using your real Chrome browser.

## Setup

### One-line install (Mac)

```bash
curl -fsSL https://raw.githubusercontent.com/aqureshiest/partner-audit-cli/main/install.sh | bash
```

This installs Homebrew (if needed), Node.js, all npm dependencies, and Playwright Chromium. It clones the repo to `~/partner-audit-cli` and wires up `.env` automatically.

After it completes, set your AWS Bedrock token:

```bash
cd ~/partner-audit-cli
nano .env  # set AWS_BEARER_TOKEN_BEDROCK=<your-token>
```

### Manual setup

```bash
git clone https://github.com/aqureshiest/partner-audit-cli.git
cd partner-audit-cli
npm install
npx playwright install chromium
cp .env.example .env
# Fill in AWS_BEARER_TOKEN_BEDROCK
```

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
