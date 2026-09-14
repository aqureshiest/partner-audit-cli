import ExcelJS from "exceljs";
import type { UrlResult } from "./analyze.js";
import type { OfficialRate } from "./rates.js";

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

export async function writeWorkbook(
    filename: string,
    results: UrlResult[],
    officialRates: OfficialRate[],
): Promise<void> {
    const auditDate = new Date().toLocaleDateString();
    const summary = computeSummary(results);

    const wb = new ExcelJS.Workbook();

    // --- Summary sheet ---
    const s = wb.addWorksheet("Summary");
    s.getColumn(1).width = 34;
    s.getColumn(2).width = 14;
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
    s.addRow([]);

    addSectionHeader("Partners needing the most attention (by high-risk violation count)");
    addTableHeader(["Partner", "High-risk violations"]);
    if (summary.topPartners.length === 0) s.addRow(["(none)"]);
    for (const p of summary.topPartners) s.addRow([p.partnerName, p.highCount]);

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

    // --- SLR Partner Audit & Correction sheet (only when SLR pages were audited) ---
    const slrResults = results.filter((res) => res.urlType === "SLR");
    if (slrResults.length > 0) {
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
