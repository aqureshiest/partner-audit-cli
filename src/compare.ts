#!/usr/bin/env tsx
/**
 * One-time comparison: run the same pages through Haiku and Sonnet side-by-side.
 * Shows what each model found that the other missed.
 *
 * Usage:
 *   tsx src/compare.ts --partner "Credible"
 *   tsx src/compare.ts --partner "SoFi" --type SLR
 */

import { config } from "dotenv";
config();

import { loadPartners, loadComplianceRules, type PartnerRow } from "./sheets.js";
import { loadOfficialRates } from "./rates.js";
import { scrapeUrls } from "./scraper.js";
import { analyzePage, HAIKU_MODEL_ID, SONNET_MODEL_ID, type UrlResult } from "./analyze.js";

const args = process.argv.slice(2);
const partnerFilters: string[] = args
    .map((a, i) => (a === "--partner" ? args[i + 1] : null))
    .filter((v): v is string => v != null);
const typeIdx = args.indexOf("--type");
const typeFilter = typeIdx !== -1 ? (args[typeIdx + 1] ?? "").toUpperCase() || null : null;

function urlsForPartner(p: PartnerRow, urlType: string | null): Array<{ url: string; urlType: string }> {
    const candidates = [
        { url: p.slrUrl, urlType: "SLR" },
        { url: p.sloUrl, urlType: "SLO" },
        { url: p.plUrl, urlType: "PL" },
    ];
    return candidates
        .filter(({ url, urlType: t }) => url && (!urlType || t === urlType))
        .map(({ url, urlType: t }) => ({ url: url!, urlType: t }));
}

function diffViolations(haikuViolations: string[], sonnetViolations: string[]): {
    onlyHaiku: string[];
    onlySonnet: string[];
    both: string[];
} {
    // Normalize for fuzzy comparison: lowercase, strip risk prefix
    const normalize = (v: string) => v.toLowerCase().replace(/^(high|medium|low) risk - /, "").trim();

    const haikuNorm = haikuViolations.map(normalize);
    const sonnetNorm = sonnetViolations.map(normalize);

    const both = haikuViolations.filter((_, i) =>
        sonnetNorm.some((s) => s.includes(haikuNorm[i]) || haikuNorm[i].includes(s))
    );
    const onlyHaiku = haikuViolations.filter((_, i) =>
        !sonnetNorm.some((s) => s.includes(haikuNorm[i]) || haikuNorm[i].includes(s))
    );
    const onlySonnet = sonnetViolations.filter((_, i) =>
        !haikuNorm.some((h) => h.includes(sonnetNorm[i]) || sonnetNorm[i].includes(h))
    );

    return { onlyHaiku, onlySonnet, both };
}

async function main() {
    console.log("Loading data...");
    const [allPartners, rules, officialRates] = await Promise.all([
        loadPartners(),
        loadComplianceRules(),
        loadOfficialRates(),
    ]);

    const partners = partnerFilters.length > 0
        ? allPartners.filter((p) => partnerFilters.some((f) => p.name.toLowerCase().includes(f.toLowerCase())))
        : allPartners;

    if (partners.length === 0) {
        console.error(`No partners found${partnerFilters.length > 0 ? ` matching "${partnerFilters.join('", "')}"` : ""}`);
        process.exit(1);
    }

    const tasks: Array<{ url: string; urlType: string; partnerName: string }> = [];
    for (const partner of partners) {
        for (const { url, urlType } of urlsForPartner(partner, typeFilter)) {
            tasks.push({ url, urlType, partnerName: partner.name });
        }
    }

    const uniquePartnerCount = new Set(partners.map((p) => p.name)).size;
    console.log(`Comparing Haiku vs Sonnet for ${uniquePartnerCount} partner(s), ${tasks.length} URL(s)\n`);

    console.log("Scraping pages...");
    const scraped = await scrapeUrls(tasks.map((t) => t.url));

    console.log("\nAnalyzing with both models in parallel...\n");

    let totalHaikuCost = 0;
    let totalSonnetCost = 0;
    let totalOnlyHaiku = 0;
    let totalOnlySonnet = 0;

    for (const task of tasks) {
        const page = scraped.find((s) => s.url === task.url);
        const content = page?.content ?? "";

        process.stdout.write(`  ${task.partnerName} [${task.urlType}] ${task.url}... `);

        const [haiku, sonnet] = await Promise.all([
            analyzePage(content, task.urlType, task.partnerName, task.url, rules, officialRates, HAIKU_MODEL_ID),
            analyzePage(content, task.urlType, task.partnerName, task.url, rules, officialRates, SONNET_MODEL_ID),
        ]);

        totalHaikuCost += haiku.cost ?? 0;
        totalSonnetCost += sonnet.cost ?? 0;

        console.log(`haiku=${haiku.status} sonnet=${sonnet.status}`);

        const { onlyHaiku, onlySonnet, both } = diffViolations(haiku.violations, sonnet.violations);
        totalOnlyHaiku += onlyHaiku.length;
        totalOnlySonnet += onlySonnet.length;

        if (both.length > 0 || onlyHaiku.length > 0 || onlySonnet.length > 0) {
            if (both.length > 0) {
                console.log(`    [BOTH] ${both.length} violation(s) agreed on`);
            }
            if (onlyHaiku.length > 0) {
                console.log(`    [HAIKU ONLY] ${onlyHaiku.length} violation(s):`);
                for (const v of onlyHaiku) console.log(`      + ${v}`);
            }
            if (onlySonnet.length > 0) {
                console.log(`    [SONNET ONLY] ${onlySonnet.length} violation(s):`);
                for (const v of onlySonnet) console.log(`      + ${v}`);
            }
        }
    }

    console.log(`\n${"═".repeat(60)}`);
    console.log(`COMPARISON SUMMARY`);
    console.log(`  URLs analyzed         : ${tasks.length}`);
    console.log(`  Only Haiku caught     : ${totalOnlyHaiku}`);
    console.log(`  Only Sonnet caught    : ${totalOnlySonnet}`);
    console.log(`  Haiku cost            : $${totalHaikuCost.toFixed(4)}`);
    console.log(`  Sonnet cost           : $${totalSonnetCost.toFixed(4)}`);
    console.log(`  Cost multiplier       : ${totalHaikuCost > 0 ? (totalSonnetCost / totalHaikuCost).toFixed(1) : "N/A"}x`);
    console.log();
    if (totalOnlySonnet === 0) {
        console.log("  Haiku caught everything Sonnet did. Stick with Haiku.");
    } else {
        console.log(`  Sonnet found ${totalOnlySonnet} additional violation(s) Haiku missed — review above.`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
