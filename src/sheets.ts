import { createReadStream } from "fs";
import { resolve } from "path";
import csvParser from "csv-parser";

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

export async function loadPartners(): Promise<PartnerRow[]> {
    const filePath = resolve(process.env.PARTNER_CSV ?? "./partner-links.csv");
    const rows = await readCsv<PartnerRow>(filePath, (row) => {
        const name = row["Partner Name"] ?? row["Name"] ?? "";
        if (!name) return null;
        const slrUrl = row["SLR URL"]?.trim() || undefined;
        const sloUrl = row["SLO URL"]?.trim() || undefined;
        const plUrl = row["PL URL"]?.trim() || undefined;
        if (!slrUrl && !sloUrl && !plUrl) return null;
        return { name, slrUrl, sloUrl, plUrl };
    });
    console.log(`Loaded ${rows.length} partners from ${filePath}`);
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
