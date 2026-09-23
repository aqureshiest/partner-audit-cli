#!/usr/bin/env tsx
/**
 * Partner compliance audit — standalone CLI
 *
 * Usage:
 *   tsx src/audit.ts                          # audit all partners, all URL types
 *   tsx src/audit.ts --partner "SoFi"         # single partner
 *   tsx src/audit.ts --type SLR               # filter by loan type
 *   tsx src/audit.ts --type "Earnest Managed" # SLR + PL only (excludes SLO)
 *   tsx src/audit.ts --output csv             # write audit-YYYY-MM-DD.xlsx
 *   tsx src/audit.ts --for "rate map change"  # tags run as rate-map, auto-scopes to SLR,
 *                                              # omits SLR Correction sheet
 *   tsx src/audit.ts --for "quarterly audit"  # tags run as quarterly (also the default)
 */

import { config } from "dotenv";
config();

import { loadPartners, loadComplianceRules, type PartnerRow } from "./sheets.js";
import { loadOfficialRates } from "./rates.js";
import { scrapeUrls } from "./scraper.js";
import { analyzePage, type UrlResult } from "./analyze.js";
import { writeWorkbook } from "./report.js";
import { buildHistoryRecord, loadHistory, pickBaseline, saveHistory, upsertHistory, type RunKind } from "./history.js";
import { spawn } from "child_process";
import { checkbox, select } from "@inquirer/prompts";

// --- CLI args ---
const args = process.argv.slice(2);
const partnerFilters: string[] = args
    .map((a, i) => (a === "--partner" ? args[i + 1] : null))
    .filter((v): v is string => v != null);
const typeIdx = args.indexOf("--type");
const typeFilter = typeIdx !== -1 ? (args[typeIdx + 1] ?? "").toUpperCase() || null : null;
const forIdx = args.indexOf("--for");
const forPhrase = forIdx !== -1 ? (args[forIdx + 1] ?? "") : "";
// --for alone still implies "produce a report" (matching the interactive prompt's own default),
// same as explicitly passing --output csv.
const outputCsvExplicit = args.includes("--output") && args[args.indexOf("--output") + 1] === "csv";
const outputCsv = outputCsvExplicit || forPhrase !== "";

function resolveRunKind(phrase: string): RunKind {
    const lower = phrase.toLowerCase();
    if (lower.includes("rate map") || lower.includes("rate change")) return "rate-map";
    return "quarterly";
}
const runKind = resolveRunKind(forPhrase);

const flagsProvided = partnerFilters.length > 0 || typeFilter !== null || outputCsv;

// "Earnest Managed" (aka "Earnest" / "Owned") = the two products Earnest directly
// manages, SLR and PL — SLO is typically managed by a third party (e.g. College Finance).
const EARNEST_MANAGED_TYPES = ["SLR", "PL"];
const TYPE_ALIASES: Record<string, string[]> = {
    SLR: ["SLR"],
    SLO: ["SLO"],
    PL: ["PL"],
    EARNEST: EARNEST_MANAGED_TYPES,
    EARNESTMANAGED: EARNEST_MANAGED_TYPES,
    OWNED: EARNEST_MANAGED_TYPES,
};

function resolveTypeFilter(raw: string | null): string[] | null {
    if (!raw) return null;
    const key = raw.toUpperCase().replace(/[\s-]/g, "");
    return TYPE_ALIASES[key] ?? [key];
}

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
            { name: "Earnest Managed — SLR + PL (excludes SLO)", value: "EARNEST" },
        ],
    });

    return { partnerFilters: chosenPartners, typeFilter: chosenType, outputCsv: true };
}

// --- Helpers ---
// Rate Type values start with "HBG" (e.g. "HBG + Partner Discount") or "Non-HBG" —
// checking the prefix (not just "includes HBG") avoids matching "Non-HBG" itself.
function isHbgPartner(rateType: string | undefined): boolean {
    return /^HBG/i.test((rateType ?? "").trim());
}

function officialRatesFor(
    urlType: string,
    isHbg: boolean,
    officialRates: import("./rates.js").OfficialRate[],
): import("./rates.js").OfficialRate[] {
    if (urlType !== "SLR" || !isHbg) return officialRates.filter((r) => r.loanType !== "SLR_HBG");
    const hbgRate = officialRates.find((r) => r.loanType === "SLR_HBG");
    if (!hbgRate) return officialRates;
    return officialRates
        .filter((r) => r.loanType !== "SLR_HBG" && r.loanType !== "SLR")
        .concat({ ...hbgRate, loanType: "SLR" });
}

function urlsForPartner(p: PartnerRow, urlTypes: string[] | null): Array<{ url: string; urlType: string }> {
    const candidates: Array<{ url: string | undefined; urlType: string }> = [
        { url: p.slrUrl, urlType: "SLR" },
        { url: p.sloUrl, urlType: "SLO" },
        { url: p.plUrl, urlType: "PL" },
    ];
    return candidates
        .filter(({ url, urlType: t }) => url && (!urlTypes || urlTypes.includes(t)))
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
    } else if (runKind === "rate-map" && typeFilter === null && partnerFilters.length === 0) {
        // A rate-map check is inherently SLR-only, unless the user explicitly scoped it themselves.
        resolvedTypeFilter = "SLR";
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
    const resolvedTypeFilters = resolveTypeFilter(resolvedTypeFilter);
    const tasks: Array<{ url: string; urlType: string; partnerName: string; isHbg: boolean }> = [];
    for (const partner of partners) {
        for (const { url, urlType } of urlsForPartner(partner, resolvedTypeFilters)) {
            tasks.push({ url, urlType, partnerName: partner.name, isHbg: isHbgPartner(partner.rateType) });
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
        process.stdout.write(`  ${task.partnerName} [${task.urlType}]${task.isHbg && task.urlType === "SLR" ? " (HBG)" : ""} ${task.url}... `);
        const ratesForTask = officialRatesFor(task.urlType, task.isHbg, officialRates);
        const result = await analyzePage(content, task.urlType, task.partnerName, task.url, rules, ratesForTask);
        console.log(result.status);
        results.push(result);
    }

    printResults(results);

    if (resolvedOutputCsv) {
        const today = new Date().toISOString().slice(0, 10);
        const history = loadHistory();
        const baseline = pickBaseline(history, today, runKind);
        if (baseline) console.log(`\nComparing against baseline run: ${baseline.date} (${baseline.kind})`);
        else console.log("\nNo prior comparable run found for a trend comparison.");

        const filename = `audit-${today}.xlsx`;
        await writeWorkbook(filename, results, officialRates, runKind, baseline);
        console.log(`Results saved to ${filename}`);
        openFile(filename);

        const currentRecord = buildHistoryRecord(today, runKind, results);
        saveHistory(upsertHistory(history, currentRecord));
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
