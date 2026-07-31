#!/usr/bin/env tsx
/**
 * Partner compliance audit — standalone CLI
 *
 * Usage:
 *   tsx src/audit.ts                          # audit all partners, all URL types
 *   tsx src/audit.ts --partner "SoFi"         # single partner
 *   tsx src/audit.ts --type SLR               # filter by loan type
 *   tsx src/audit.ts --output csv             # write results.csv
 */

import { config } from "dotenv";
config();

import { loadPartners, loadComplianceRules, type PartnerRow } from "./sheets.js";
import { loadOfficialRates } from "./rates.js";
import { scrapeUrls } from "./scraper.js";
import { analyzePage, type UrlResult } from "./analyze.js";
import { writeFileSync } from "fs";
import { spawn } from "child_process";
import { checkbox, select } from "@inquirer/prompts";

// --- CLI args ---
const args = process.argv.slice(2);
const partnerFilters: string[] = args
    .map((a, i) => (a === "--partner" ? args[i + 1] : null))
    .filter((v): v is string => v != null);
const typeIdx = args.indexOf("--type");
const typeFilter = typeIdx !== -1 ? (args[typeIdx + 1] ?? "").toUpperCase() || null : null;
const outputCsv = args.includes("--output") && args[args.indexOf("--output") + 1] === "csv";

const flagsProvided = partnerFilters.length > 0 || typeFilter !== null || outputCsv;

async function promptForOptions(allPartnerNames: string[]): Promise<{
    partnerFilters: string[];
    typeFilter: string | null;
    outputCsv: boolean;
}> {
    const selectedPartners = await checkbox({
        message: "Select partners to audit (space to select, enter to confirm):",
        choices: [
            { name: "All partners", value: "__all__" },
            ...allPartnerNames.map((name) => ({ name, value: name })),
        ],
    });

    const auditAll = selectedPartners.includes("__all__") || selectedPartners.length === 0;
    const chosenPartners = auditAll ? [] : selectedPartners;

    const chosenType = await select({
        message: "Filter by loan type?",
        choices: [
            { name: "All", value: null },
            { name: "SLR — Student Loan Refinancing", value: "SLR" },
            { name: "SLO — Student Loan Origination", value: "SLO" },
            { name: "PL  — Personal Loans", value: "PL" },
        ],
    });

    return { partnerFilters: chosenPartners, typeFilter: chosenType, outputCsv: true };
}

// --- Helpers ---
function urlsForPartner(p: PartnerRow, urlType: string | null): Array<{ url: string; urlType: string }> {
    const candidates: Array<{ url: string | undefined; urlType: string }> = [
        { url: p.slrUrl, urlType: "SLR" },
        { url: p.sloUrl, urlType: "SLO" },
        { url: p.plUrl, urlType: "PL" },
    ];
    return candidates
        .filter(({ url, urlType: t }) => url && (!urlType || t === urlType))
        .map(({ url, urlType: t }) => ({ url: url!, urlType: t }));
}

function printResults(results: UrlResult[]) {
    const byPartner = new Map<string, UrlResult[]>();
    for (const r of results) {
        const list = byPartner.get(r.partnerName) ?? [];
        list.push(r);
        byPartner.set(r.partnerName, list);
    }

    let totalViolations = 0;
    let totalWarnings = 0;
    let compliant = 0;

    for (const [partner, rows] of byPartner) {
        const hasIssues = rows.some((r) => r.violations.length > 0);
        console.log(`\n${"─".repeat(60)}`);
        console.log(`Partner: ${partner}`);
        for (const r of rows) {
            const tag = r.status === "compliant" ? "✓" : r.status === "violations" ? "✗" : r.status === "warnings" ? "⚠" : "?";
            console.log(`  [${tag}] ${r.urlType} — ${r.url}`);
            for (const v of r.violations) {
                console.log(`       ${v}`);
            }
            if (r.error) console.log(`       Error: ${r.error}`);
        }
        if (!hasIssues) compliant++;
        totalViolations += rows.filter((r) => r.status === "violations").length;
        totalWarnings += rows.filter((r) => r.status === "warnings").length;
    }

    const totalCost = results.reduce((sum, r) => sum + (r.cost ?? 0), 0);
    const totalInputTokens = results.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
    const totalOutputTokens = results.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);

    console.log(`\n${"═".repeat(60)}`);
    console.log(`SUMMARY`);
    console.log(`  Partners audited : ${byPartner.size}`);
    console.log(`  Compliant        : ${compliant}`);
    console.log(`  With violations  : ${totalViolations}`);
    console.log(`  With warnings    : ${totalWarnings}`);
    console.log(`  Tokens used      : ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out`);
    console.log(`  Cost             : $${totalCost.toFixed(4)}`);
}

function toCsv(results: UrlResult[], officialRates: import("./rates.js").OfficialRate[]): string {
    // Group by partner name for summary columns
    const byPartner = new Map<string, UrlResult[]>();
    for (const r of results) {
        const list = byPartner.get(r.partnerName) ?? [];
        list.push(r);
        byPartner.set(r.partnerName, list);
    }

    const auditDate = new Date().toLocaleDateString();
    const officialRatesInfo = officialRates
        .map((r) => `${r.loanType}: Fixed ${r.fixedLow}%–${r.fixedHigh}%, Variable ${r.variableLow}%–${r.variableHigh}%`)
        .join("; ");

    const headers = [
        "Partner Name",
        "Overall Status",
        "Urgency",
        "High Risk Violations Count",
        "Medium Risk Violations Count",
        "URL Type",
        "URL",
        "Compliance Status",
        "Violations & Issues",
        "Scraping Error",
        "Audit Date",
        "Official Rates Info",
    ];

    const rows = results.map((r) => {
        const partnerResults = byPartner.get(r.partnerName) ?? [r];
        const hasViolations = partnerResults.some((x) => x.status === "violations");
        const hasWarnings = partnerResults.some((x) => x.status === "warnings");
        const overallStatus = hasViolations ? "violations" : hasWarnings ? "warnings" : "compliant";
        const urgency = hasViolations ? "high" : hasWarnings ? "medium" : "low";

        const highCount = r.violations.filter((v) => v.startsWith("HIGH")).length;
        const medCount = r.violations.filter((v) => v.startsWith("MEDIUM")).length;

        return [
            r.partnerName,
            overallStatus,
            urgency,
            highCount,
            medCount,
            r.urlType,
            r.url,
            r.status,
            r.violations.join("\n"),
            r.error ?? "",
            auditDate,
            officialRatesInfo,
        ];
    });

    return [headers, ...rows]
        .map((row) =>
            row.map((cell) => {
                const s = String(cell);
                return s.includes(",") || s.includes('"') || s.includes("\n")
                    ? `"${s.replace(/"/g, '""')}"`
                    : s;
            }).join(",")
        )
        .join("\n");
}

// --- Main ---
async function main() {
    console.log("Loading partners and compliance rules from local CSVs...");
    const [allPartners, rules, officialRates] = await Promise.all([
        loadPartners(),
        loadComplianceRules(),
        loadOfficialRates(),
    ]);

    let resolvedPartnerFilters = partnerFilters;
    let resolvedTypeFilter = typeFilter;
    let resolvedOutputCsv = outputCsv;

    if (!flagsProvided) {
        const answers = await promptForOptions([...new Set(allPartners.map((p) => p.name))]);
        resolvedPartnerFilters = answers.partnerFilters;
        resolvedTypeFilter = answers.typeFilter;
        resolvedOutputCsv = answers.outputCsv;
    }

    const partners = resolvedPartnerFilters.length > 0
        ? allPartners.filter((p) =>
            flagsProvided
                ? resolvedPartnerFilters.some((f) => p.name.toLowerCase().includes(f.toLowerCase()))
                : resolvedPartnerFilters.includes(p.name)
          )
        : allPartners;

    if (partners.length === 0) {
        console.error(`No partners found${partnerFilters.length > 0 ? ` matching "${partnerFilters.join('", "')}"` : ""}`);
        process.exit(1);
    }

    // Collect all URLs to scrape
    const tasks: Array<{ url: string; urlType: string; partnerName: string }> = [];
    for (const partner of partners) {
        for (const { url, urlType } of urlsForPartner(partner, resolvedTypeFilter)) {
            tasks.push({ url, urlType, partnerName: partner.name });
        }
    }

    const uniquePartnerCount = new Set(partners.map((p) => p.name)).size;
    console.log(`Auditing ${uniquePartnerCount} partner(s), ${tasks.length} URL(s)...\n`);

    // Scrape all URLs with local Chrome
    console.log("Scraping pages with local Chrome...");
    const scraped = await scrapeUrls(tasks.map((t) => t.url));

    // Analyze each page
    console.log("\nAnalyzing content with Claude...");
    const results: UrlResult[] = [];

    for (const task of tasks) {
        const page = scraped.find((s) => s.url === task.url);
        const content = page?.content ?? "";
        process.stdout.write(`  ${task.partnerName} [${task.urlType}] ${task.url}... `);
        const result = await analyzePage(content, task.urlType, task.partnerName, task.url, rules, officialRates);
        console.log(result.status);
        results.push(result);
    }

    printResults(results);

    if (resolvedOutputCsv) {
        const filename = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
        writeFileSync(filename, toCsv(results, officialRates));
        console.log(`\nResults saved to ${filename}`);
        openFile(filename);
    }
}

function openFile(filePath: string): void {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const args = process.platform === "win32" ? ["", filePath] : [filePath];
    const shell = process.platform === "win32";
    spawn(command, args, { detached: true, stdio: "ignore", shell }).unref();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
