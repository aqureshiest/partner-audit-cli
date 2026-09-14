import { createReadStream, statSync } from "fs";
import { resolve } from "path";
import csvParser from "csv-parser";
import { google } from "googleapis";

export interface PartnerRow {
    name: string;
    slrUrl?: string;
    sloUrl?: string;
    plUrl?: string;
}

export interface ComplianceRule {
    claim: string;
    product: string;
    riskLevel: string;
    recommendation: string;
}

function readCsv<T>(filePath: string, mapper: (row: Record<string, string>) => T | null): Promise<T[]> {
    return new Promise((resolve: (value: T[]) => void, reject) => {
        const results: T[] = [];
        createReadStream(filePath)
            .pipe(csvParser())
            .on("data", (row: Record<string, string>) => {
                const mapped = mapper(row);
                if (mapped !== null) results.push(mapped);
            })
            .on("end", () => resolve(results))
            .on("error", reject);
    });
}

function mapPartnerRow(row: Record<string, string>): PartnerRow | null {
    const name = row["Partner Name"] ?? row["Name"] ?? "";
    if (!name) return null;
    const slrUrl = row["SLR URL"]?.trim() || undefined;
    const sloUrl = row["SLO URL"]?.trim() || undefined;
    const plUrl = row["PL URL"]?.trim() || undefined;
    if (!slrUrl && !sloUrl && !plUrl) return null;
    return { name, slrUrl, sloUrl, plUrl };
}

async function fetchSheetRows(sheetId: string, tabName: string): Promise<Record<string, string>[]> {
    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!keyFile) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set");

    const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: tabName });

    const values = res.data.values ?? [];
    if (values.length === 0) return [];
    const [headers, ...dataRows] = values;
    return dataRows.map((row) => {
        const record: Record<string, string> = {};
        headers.forEach((header, i) => { record[header] = row[i] ?? ""; });
        return record;
    });
}

export async function loadPartners(): Promise<PartnerRow[]> {
    const sheetId = process.env.PARTNER_SHEET_ID;
    const tabName = process.env.PARTNER_SHEET_TAB ?? "Audit Links";

    if (sheetId) {
        try {
            const rows = await fetchSheetRows(sheetId, tabName);
            const partners = rows.map(mapPartnerRow).filter((p): p is PartnerRow => p !== null);
            console.log(`Loaded ${partners.length} partners live from Google Sheets ("${tabName}" tab)`);
            return partners;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`Could not reach the live "${tabName}" sheet (${message}).`);
        }
    }

    const filePath = resolve(process.env.PARTNER_CSV ?? "./partner-links.csv");
    const rows = await readCsv<PartnerRow>(filePath, mapPartnerRow);

    let asOf = "unknown date";
    try {
        asOf = statSync(filePath).mtime.toLocaleDateString();
    } catch {
        // file missing entirely — readCsv above will already have thrown
    }
    console.warn(`WARNING: using local fallback ${filePath} — this is an OLD version of the partner list (last updated ${asOf}).`);
    console.log(`Loaded ${rows.length} partners from local fallback ${filePath}`);
    return rows;
}

export async function loadComplianceRules(): Promise<ComplianceRule[]> {
    const filePath = resolve(process.env.COMPLIANCE_RULES_CSV ?? "./compliance-rules.csv");
    const rules = await readCsv<ComplianceRule>(filePath, (row) => {
        const claim = row["Claim"] ?? "";
        if (!claim) return null;
        return {
            claim,
            product: row["Product"] ?? "ALL",
            riskLevel: row["If Yes, Then Flag"] ?? "MEDIUM Risk",
            recommendation: row["And recommend (i.e. Compliance Comment)"] ?? "",
        };
    });
    console.log(`Loaded ${rules.length} compliance rules from ${filePath}`);
    return rules;
}
