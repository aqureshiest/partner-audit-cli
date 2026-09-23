import ExcelJS from "exceljs";
import type { UrlResult } from "./analyze.js";
import type { OfficialRate } from "./rates.js";
import {
    buildHistoryRecord,
    computePageTrend,
    computePartnerTrend,
    type HistoryRecord,
    type RunKind,
} from "./history.js";

interface PartnerRollup {
    partnerName: string;
    pageCount: number;
    overallStatus: "compliant" | "violations" | "warnings";
    urgency: "low" | "medium" | "high";
    highCount: number;
    medCount: number;
}

function rollupByPartner(results: UrlResult[]): Map<string, PartnerRollup> {
    const byPartner = new Map<string, UrlResult[]>();
    for (const r of results) {
        const list = byPartner.get(r.partnerName) ?? [];
        list.push(r);
        byPartner.set(r.partnerName, list);
    }

    const rollups = new Map<string, PartnerRollup>();
    for (const [partnerName, rows] of byPartner) {
        const hasViolations = rows.some((r) => r.status === "violations");
        const hasWarnings = rows.some((r) => r.status === "warnings");
        const overallStatus = hasViolations ? "violations" : hasWarnings ? "warnings" : "compliant";
        const urgency = hasViolations ? "high" : hasWarnings ? "medium" : "low";
        const highCount = rows.reduce((sum, r) => sum + r.violations.filter((v) => v.startsWith("HIGH")).length, 0);
        const medCount = rows.reduce((sum, r) => sum + r.violations.filter((v) => v.startsWith("MEDIUM")).length, 0);
        rollups.set(partnerName, { partnerName, pageCount: rows.length, overallStatus, urgency, highCount, medCount });
    }
    return rollups;
}

export function computeSummary(results: UrlResult[]) {
    const partnerRollups = [...rollupByPartner(results).values()];

    const totalPartners = partnerRollups.length;
    const totalPages = results.length;
    const avgPagesPerPartner = totalPartners > 0 ? totalPages / totalPartners : 0;

    const pageStatus = { compliant: 0, violations: 0, warnings: 0, blocked: 0, error: 0 };
    for (const r of results) pageStatus[r.status as keyof typeof pageStatus]++;

    const partnerStatus = { fullyCompliant: 0, withViolations: 0, warningsOnly: 0 };
    for (const p of partnerRollups) {
        if (p.overallStatus === "violations") partnerStatus.withViolations++;
        else if (p.overallStatus === "warnings") partnerStatus.warningsOnly++;
        else partnerStatus.fullyCompliant++;
    }

    const byType = new Map<string, { total: number; compliant: number; violations: number; warnings: number }>();
    for (const r of results) {
        const entry = byType.get(r.urlType) ?? { total: 0, compliant: 0, violations: 0, warnings: 0 };
        entry.total++;
        if (r.status === "compliant") entry.compliant++;
        if (r.status === "violations") entry.violations++;
        if (r.status === "warnings") entry.warnings++;
        byType.set(r.urlType, entry);
    }

    const riskTotals = { high: 0, medium: 0 };
    const categoryCounts = new Map<string, number>();
    for (const r of results) {
        for (const v of r.violations) {
            if (v.startsWith("HIGH")) riskTotals.high++;
            if (v.startsWith("MEDIUM")) riskTotals.medium++;
            const match = v.match(/^(?:HIGH|MEDIUM|LOW) RISK - ([^:]+):/);
            if (match) categoryCounts.set(match[1].trim(), (categoryCounts.get(match[1].trim()) ?? 0) + 1);
        }
    }
    const topCategories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    const topPartners = [...partnerRollups]
        .filter((p) => p.highCount > 0)
        .sort((a, b) => b.highCount - a.highCount)
        .slice(0, 5);

    return { totalPartners, totalPages, avgPagesPerPartner, pageStatus, partnerStatus, byType, riskTotals, topCategories, topPartners };
}

function pct(n: number, total: number): string {
    return total > 0 ? `${((100 * n) / total).toFixed(1)}%` : "—";
}

function fmtCountDelta(delta: number | null): string {
    if (delta === null) return "new";
    if (delta === 0) return "flat";
    return delta > 0 ? `+${delta}` : `${delta}`;
}

function fmtPtsDelta(delta: number | null): string {
    if (delta === null) return "—";
    if (Math.abs(delta) < 0.05) return "flat";
    return `${delta > 0 ? "+" : ""}${delta.toFixed(1)} pts`;
}

function runKindLabel(kind: RunKind, urlTypes: string[]): string {
    const types = [...new Set(urlTypes)];
    if (kind === "rate-map") return `Rate-Map Check — ${types.join("/") || "SLR"} only`;
    return types.length > 1 ? "Quarterly Audit — all types" : `Quarterly Audit — ${types[0] ?? ""} only`;
}

export async function writeWorkbook(
    filename: string,
    results: UrlResult[],
    officialRates: OfficialRate[],
    kind: RunKind,
    baseline: HistoryRecord | null,
): Promise<void> {
    const auditDate = new Date().toLocaleDateString();
    const summary = computeSummary(results);
    const currentRecord = buildHistoryRecord(new Date().toISOString().slice(0, 10), kind, results);
    const pageTrend = baseline ? computePageTrend(currentRecord.pages, baseline) : null;
    const partnerTrend = baseline ? computePartnerTrend(currentRecord.partners, currentRecord.pages, baseline) : null;

    const wb = new ExcelJS.Workbook();

    // --- Summary sheet ---
    const s = wb.addWorksheet("Summary");
    s.getColumn(1).width = 34;
    s.getColumn(2).width = 16;
    s.getColumn(3).width = 14;
    s.getColumn(4).width = 14;
    s.getColumn(5).width = 14;

    const bold = { font: { bold: true } };
    const addSectionHeader = (title: string) => {
        const row = s.addRow([title]);
        row.font = { bold: true, size: 13 };
        s.addRow([]);
    };
    const addTableHeader = (cells: string[]) => {
        const row = s.addRow(cells);
        row.eachCell((c) => (c.font = bold.font));
    };

    s.addRow([`Executive Summary — Audit run ${auditDate}`]).font = { bold: true, size: 15 };
    s.addRow([runKindLabel(kind, results.map((r) => r.urlType))]).font = { italic: true };
    s.addRow([]);

    // --- A. Executive Summary ---
    addSectionHeader("Executive Summary");
    const pageCompliancePct = summary.totalPages > 0 ? (100 * summary.pageStatus.compliant) / summary.totalPages : 0;
    const highRiskPartnerCount = currentRecord.partners.filter((p) => p.highCount > 0).length;

    let trendSentence: string;
    if (!pageTrend || pageTrend.matchedCount === 0) {
        trendSentence = "No prior comparable run found — this is the first tracked run of this kind.";
    } else {
        const net = pageTrend.baselineHighSum - pageTrend.currentHighSum; // positive = improved
        const direction = net > 0 ? "Improved" : net < 0 ? "Declined" : "Flat";
        trendSentence = `${direction} vs. the ${baseline!.date} run — on the ${pageTrend.matchedCount} pages audited both times, ` +
            `${pageTrend.improved} improved, ${pageTrend.regressed} regressed, ${pageTrend.unchanged} unchanged.`;
    }

    s.addRow([
        `${summary.totalPartners} partners, ${summary.totalPages} pages. ${pageCompliancePct.toFixed(0)}% of pages fully compliant; ` +
        `${highRiskPartnerCount} of ${summary.totalPartners} partners carry at least one high-risk violation. ${trendSentence}`,
    ]).alignment = { wrapText: true };
    s.addRow([]);

    addTableHeader(["Metric", "Value", "vs. prior*"]);
    s.addRow([
        "Page compliance rate",
        `${pct(summary.pageStatus.compliant, summary.totalPages)} (${summary.pageStatus.compliant}/${summary.totalPages})`,
        pageTrend ? fmtPtsDelta(pageTrend.matchedCount > 0
            ? (100 * pageTrend.currentCompliantCount) / pageTrend.matchedCount - (100 * pageTrend.baselineCompliantCount) / pageTrend.matchedCount
            : null) : "—",
    ]);
    s.addRow([
        "Partner compliance rate",
        `${pct(summary.partnerStatus.fullyCompliant, summary.totalPartners)} (${summary.partnerStatus.fullyCompliant}/${summary.totalPartners})`,
        partnerTrend ? fmtPtsDelta(partnerTrend.matchedPartnerCount > 0
            ? (100 * partnerTrend.currentCompliantCount) / partnerTrend.matchedPartnerCount - (100 * partnerTrend.baselineCompliantCount) / partnerTrend.matchedPartnerCount
            : null) : "—",
    ]);
    s.addRow([
        "Partners with ≥1 high-risk flag",
        `${highRiskPartnerCount} of ${summary.totalPartners}`,
        partnerTrend ? fmtCountDelta(partnerTrend.currentWithHighRiskCount - partnerTrend.baselineWithHighRiskCount) : "—",
    ]);
    s.addRow([
        "High-risk violation flags",
        summary.riskTotals.high,
        pageTrend ? fmtCountDelta(pageTrend.currentHighSum - pageTrend.baselineHighSum) : "—",
    ]);
    s.addRow([
        "Pages not analyzed",
        `${summary.pageStatus.blocked + summary.pageStatus.error} of ${summary.totalPages}`,
        pageTrend ? fmtCountDelta(pageTrend.currentNotAnalyzedCount - pageTrend.baselineNotAnalyzedCount) : "—",
    ]);
    if (baseline) {
        s.addRow(["* Deltas compare only pages/partners audited in both runs (matched by URL) — not raw run totals, since page coverage differs run to run."]).font = { italic: true, size: 9 };
    }
    s.addRow([]);

    // --- B. Partners Needing the Most Attention ---
    addSectionHeader("Partners Needing the Most Attention (by high-risk violation count)");
    addTableHeader(["Partner", "High-risk violations", "vs. prior", "Pages"]);
    if (summary.topPartners.length === 0) s.addRow(["(none)"]);
    for (const p of summary.topPartners) {
        const delta = partnerTrend ? partnerTrend.highCountDeltaByPartner.get(p.partnerName) ?? null : null;
        s.addRow([p.partnerName, p.highCount, partnerTrend ? fmtCountDelta(delta) : "—", p.pageCount]);
    }
    s.addRow([]);

    // --- C. Details ---
    addSectionHeader("Details");
    s.addRow([]);

    addSectionHeader("Overview");
    s.addRow(["Partners audited", summary.totalPartners]);
    s.addRow(["Total pages checked", summary.totalPages]);
    s.addRow(["Avg. pages per partner", summary.avgPagesPerPartner.toFixed(1)]);
    s.addRow(["Pages that couldn't be scraped/analyzed", summary.pageStatus.blocked + summary.pageStatus.error]);
    s.addRow([]);

    addSectionHeader("Compliance — by page");
    addTableHeader(["Status", "Count", "%"]);
    s.addRow(["Compliant", summary.pageStatus.compliant, pct(summary.pageStatus.compliant, summary.totalPages)]);
    s.addRow(["Violations", summary.pageStatus.violations, pct(summary.pageStatus.violations, summary.totalPages)]);
    s.addRow(["Warnings only", summary.pageStatus.warnings, pct(summary.pageStatus.warnings, summary.totalPages)]);
    s.addRow(["Blocked / no content", summary.pageStatus.blocked, pct(summary.pageStatus.blocked, summary.totalPages)]);
    s.addRow(["Error", summary.pageStatus.error, pct(summary.pageStatus.error, summary.totalPages)]);
    s.addRow([]);

    addSectionHeader("Compliance — by partner");
    addTableHeader(["Status", "Count", "%"]);
    s.addRow(["Fully compliant (all pages clean)", summary.partnerStatus.fullyCompliant, pct(summary.partnerStatus.fullyCompliant, summary.totalPartners)]);
    s.addRow(["Has at least one violation", summary.partnerStatus.withViolations, pct(summary.partnerStatus.withViolations, summary.totalPartners)]);
    s.addRow(["Warnings only, no violations", summary.partnerStatus.warningsOnly, pct(summary.partnerStatus.warningsOnly, summary.totalPartners)]);
    s.addRow([]);

    addSectionHeader("By loan type");
    addTableHeader(["Type", "Pages", "Compliant", "Violations", "Warnings"]);
    for (const [type, entry] of summary.byType) {
        s.addRow([type, entry.total, `${entry.compliant} (${pct(entry.compliant, entry.total)})`, entry.violations, entry.warnings]);
    }
    s.addRow([]);

    addSectionHeader("Violation severity");
    addTableHeader(["High risk", "Medium risk"]);
    s.addRow([summary.riskTotals.high, summary.riskTotals.medium]);
    s.addRow([]);

    addSectionHeader("Most common issues");
    addTableHeader(["Category", "Count"]);
    if (summary.topCategories.length === 0) s.addRow(["(none)"]);
    for (const [category, count] of summary.topCategories) s.addRow([category, count]);

    // --- Results sheet ---
    const r = wb.addWorksheet("Results");
    const rateLabel = (loanType: string) => (loanType === "SLR_HBG" ? "SLR (HBG)" : loanType);
    const officialRatesInfo = officialRates
        .map((o) => `${rateLabel(o.loanType)}: Fixed ${o.fixedLow}%–${o.fixedHigh}%, Variable ${o.variableLow}%–${o.variableHigh}%`)
        .join("; ");

    const rollups = rollupByPartner(results);
    r.columns = [
        { header: "Partner Name", key: "partnerName", width: 24 },
        { header: "Overall Status", key: "overallStatus", width: 14 },
        { header: "Urgency", key: "urgency", width: 10 },
        { header: "High Risk Violations Count", key: "highCount", width: 14 },
        { header: "Medium Risk Violations Count", key: "medCount", width: 14 },
        { header: "URL Type", key: "urlType", width: 10 },
        { header: "URL", key: "url", width: 50 },
        { header: "Compliance Status", key: "status", width: 16 },
        { header: "Violations & Issues", key: "violations", width: 60 },
        { header: "Scraping Error", key: "error", width: 24 },
        { header: "Audit Date", key: "auditDate", width: 14 },
        { header: "Official Rates Info", key: "officialRatesInfo", width: 40 },
    ];
    r.getRow(1).font = bold.font;

    for (const res of results) {
        const rollup = rollups.get(res.partnerName);
        r.addRow({
            partnerName: res.partnerName,
            overallStatus: rollup?.overallStatus ?? res.status,
            urgency: rollup?.urgency ?? "low",
            highCount: res.violations.filter((v) => v.startsWith("HIGH")).length,
            medCount: res.violations.filter((v) => v.startsWith("MEDIUM")).length,
            urlType: res.urlType,
            url: res.url,
            status: res.status,
            violations: res.violations.join("\n"),
            error: res.error ?? "",
            auditDate,
            officialRatesInfo,
        });
    }
    for (const row of r.getRows(2, results.length) ?? []) row.alignment = { wrapText: true, vertical: "top" };

    // --- SLR Partner Audit & Correction sheet (only for quarterly runs with SLR pages) ---
    const slrResults = results.filter((res) => res.urlType === "SLR");
    if (kind !== "rate-map" && slrResults.length > 0) {
        const c = wb.addWorksheet("SLR Partner Audit & Correction");
        c.columns = [
            { header: "Partner", key: "partner", width: 24 },
            { header: "Compliance Status", key: "complianceStatus", width: 16 },
            { header: "Approved for Comms", key: "approvedForComms", width: 16 },
            { header: "Comms Sent", key: "commsSent", width: 12 },
            { header: "Compliant Corrections Completed", key: "correctionsCompleted", width: 16 },
            { header: "URL", key: "url", width: 50 },
            { header: "AI Tool Findings", key: "findings", width: 60 },
            { header: "Compliance Corrections", key: "corrections", width: 40 },
        ];
        c.getRow(1).font = bold.font;

        for (const res of slrResults) {
            const complianceStatus =
                res.status === "compliant" ? "Compliant" :
                res.status === "violations" || res.status === "warnings" ? "Non-Compliant" :
                "Review Required";
            const findings = res.violations.length > 0
                ? res.violations.join("\n")
                : res.error ? res.error : "No compliance notes on this page.";

            c.addRow({
                partner: res.partnerName,
                complianceStatus,
                approvedForComms: "",
                commsSent: "",
                correctionsCompleted: "",
                url: res.url,
                findings,
                corrections: "",
            });
        }
        for (const row of c.getRows(2, slrResults.length) ?? []) row.alignment = { wrapText: true, vertical: "top" };
    }

    await wb.xlsx.writeFile(filename);
}
