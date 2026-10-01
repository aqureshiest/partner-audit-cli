#!/usr/bin/env tsx
/**
 * Generates Gmail drafts (one per partner) from a reviewed quarterly report's
 * "SLR Partner Audit & Correction" tab.
 *
 * Usage:
 *   npm run generate-emails -- "<Drive file ID or link>" --respond-by "October 15, 2026"
 */
import { config } from "dotenv";
config();

import ExcelJS from "exceljs";
import { downloadReportFromDrive } from "./drive.js";
import { loadPartners } from "./sheets.js";
import type { OfficialRate } from "./rates.js";
import { loadComplianceContacts, findContactsForPartner } from "./contacts.js";
import { buildEmailSubject, buildEmailBody, type CorrectionItem } from "./email-template.js";
import { createGmailDraft, checkGmailSetup } from "./gmail.js";

const args = process.argv.slice(2);
const driveLink = args.find((a) => !a.startsWith("--"));
const respondByIdx = args.indexOf("--respond-by");
const respondBy = respondByIdx !== -1 ? args[respondByIdx + 1] : undefined;

if (!driveLink || !respondBy) {
    console.error('Usage: npm run generate-emails -- "<Drive file ID or link>" --respond-by "October 15, 2026"');
    process.exit(1);
}

function isHbgPartner(rateType: string | undefined): boolean {
    return /^HBG/i.test((rateType ?? "").trim());
}

interface CorrectionRow {
    partner: string;
    complianceStatus: string;
    url: string;
    findings: string;
    corrections: string;
}

function readCorrectionRows(ws: ExcelJS.Worksheet): CorrectionRow[] {
    const rows: CorrectionRow[] = [];
    for (let i = 2; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const partner = row.getCell(1).value;
        if (!partner) continue;
        rows.push({
            partner: String(partner),
            complianceStatus: String(row.getCell(2).value ?? ""),
            url: String(row.getCell(6).value ?? ""),
            findings: String(row.getCell(7).value ?? ""),
            corrections: String(row.getCell(8).value ?? ""),
        });
    }
    return rows;
}

function readOfficialRates(summarySheet: ExcelJS.Worksheet): OfficialRate[] {
    const rates: OfficialRate[] = [];
    let inTable = false;
    for (let i = 1; i <= summarySheet.rowCount; i++) {
        const row = summarySheet.getRow(i);
        const first = row.getCell(1).value;
        if (first === "Loan Type") {
            inTable = true;
            continue;
        }
        if (!inTable) continue;
        if (!first) break;
        rates.push({
            loanType: String(first),
            fixedLow: Number(row.getCell(2).value),
            fixedHigh: Number(row.getCell(3).value),
            variableLow: Number(row.getCell(4).value),
            variableHigh: Number(row.getCell(5).value),
            rateMapVersion: row.getCell(6).value ? String(row.getCell(6).value) : null,
            effectiveDate: row.getCell(7).value ? String(row.getCell(7).value) : null,
        });
    }
    return rates;
}

function readAuditDate(summarySheet: ExcelJS.Worksheet): Date {
    const title = String(summarySheet.getRow(1).getCell(1).value ?? "");
    const match = title.match(/Audit run (\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!match) return new Date();
    const [, month, day, year] = match;
    return new Date(Number(year), Number(month) - 1, Number(day));
}

function quarterOf(date: Date): number {
    return Math.floor(date.getMonth() / 3) + 1;
}

async function main() {
    const gmailStatus = checkGmailSetup();
    if (!gmailStatus.connected) {
        console.error(gmailStatus.fixSteps.join("\n"));
        process.exit(1);
    }

    console.log("Downloading reviewed report from Drive...");
    const localPath = "/tmp/reviewed-report.xlsx";
    await downloadReportFromDrive(driveLink!, localPath);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(localPath);

    const summarySheet = wb.getWorksheet("Summary");
    const correctionSheet = wb.getWorksheet("SLR Partner Audit & Correction");
    if (!summarySheet || !correctionSheet) {
        console.error(
            'This file has no "SLR Partner Audit & Correction" tab — it\'s either a rate-map report ' +
            "(which never has one) or not a report this tool generated. Email generation only works " +
            "for quarterly audit reports.",
        );
        process.exit(1);
    }

    const officialRates = readOfficialRates(summarySheet);
    const slrRate = officialRates.find((r) => r.loanType === "SLR");
    const sloRate = officialRates.find((r) => r.loanType === "SLO");
    if (!slrRate || !sloRate) {
        console.error('Could not find SLR/SLO rate data in this report\'s Summary tab ("Rate Data" section).');
        process.exit(1);
    }

    const auditDate = readAuditDate(summarySheet);
    const quarter = quarterOf(auditDate);
    const year = auditDate.getFullYear();

    const rows = readCorrectionRows(correctionSheet);
    const byPartner = new Map<string, CorrectionRow[]>();
    for (const row of rows) {
        if (row.complianceStatus !== "Non-Compliant") continue;
        if (!row.corrections.trim()) continue; // not yet reviewed by compliance
        byPartner.set(row.partner, [...(byPartner.get(row.partner) ?? []), row]);
    }

    if (byPartner.size === 0) {
        console.log("No partners found with reviewed corrections (Non-Compliant + a filled-in Compliance Corrections value). Nothing to draft.");
        return;
    }

    console.log(`Found ${byPartner.size} partner(s) with reviewed corrections. Looking up rate types and contacts...`);
    const allPartners = await loadPartners();
    const hbgContactsCache = new Map<boolean, Awaited<ReturnType<typeof loadComplianceContacts>>>();

    let created = 0;
    const skipped: string[] = [];

    for (const [partnerName, correctionRows] of byPartner) {
        const partnerInfo = allPartners.find((p) => p.name === partnerName);
        const isHbg = isHbgPartner(partnerInfo?.rateType);

        if (!hbgContactsCache.has(isHbg)) hbgContactsCache.set(isHbg, await loadComplianceContacts(isHbg));
        const contacts = findContactsForPartner(partnerName, hbgContactsCache.get(isHbg)!);

        if (contacts.length === 0) {
            skipped.push(partnerName);
            continue;
        }

        const items: CorrectionItem[] = correctionRows.map((r) => ({
            example: r.findings,
            link: r.url,
            correction: r.corrections,
        }));

        const subject = buildEmailSubject(quarter, year);
        const body = buildEmailBody({ quarter, year, slrRate, sloRate, corrections: items, respondByDate: respondBy! });
        const to = contacts.map((c) => c.email).join(", ");

        await createGmailDraft(to, subject, body);
        console.log(`  Draft created for ${partnerName} -> ${to}`);
        created++;
    }

    console.log(`\n${created} draft(s) created.`);
    if (skipped.length > 0) {
        console.log(`Skipped (no compliance contact found — needs manual handling): ${skipped.join(", ")}`);
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
