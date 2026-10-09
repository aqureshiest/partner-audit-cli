import { google } from "googleapis";
import { normalizeName, diceCoefficient } from "./history.js";

export interface ComplianceContact {
    name: string;
    title: string;
    email: string;
}

async function fetchContactRows(tabName: string): Promise<string[][]> {
    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const sheetId = process.env.COMPLIANCE_CONTACTS_SHEET_ID;
    if (!keyFile) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set");
    if (!sheetId) throw new Error("COMPLIANCE_CONTACTS_SHEET_ID is not set");

    const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tabName}!A1:J1000` });
    return res.data.values ?? [];
}

/**
 * Loads the HBG or Non-HBG SLR compliance contacts tab, keyed by normalized partner
 * name (resolved per-row via the sheet's own "Communications should use:" column —
 * some partners are matched by Company Name, others by DBA Name).
 */
export async function loadComplianceContacts(isHbg: boolean): Promise<Map<string, ComplianceContact[]>> {
    const tabName = isHbg ? "HBG SLR Compliance Contacts" : "Non-HBG SLR Compliance Contacts";
    const rows = await fetchContactRows(tabName);

    const byPartner = new Map<string, ComplianceContact[]>();
    // Row 0 is a stray "Click here for archived list" link, row 1 is the real header.
    for (const row of rows.slice(2)) {
        const [companyName, dbaName, useField, , , , status, contactName, contactTitle, contactEmail] = row;
        if ((status ?? "").trim().toLowerCase() !== "active") continue;
        if (!contactEmail) continue;

        const name = (useField ?? "").trim() === "DBA Name" ? dbaName : companyName;
        if (!name) continue;

        const key = normalizeName(name);
        const list = byPartner.get(key) ?? [];
        list.push({ name: contactName ?? "", title: contactTitle ?? "", email: contactEmail.trim() });
        byPartner.set(key, list);
    }
    return byPartner;
}

const NAME_MATCH_THRESHOLD = 0.85;

/** Finds the best-matching partner key in a loaded contacts map, via the same fuzzy-match rule used for run-to-run partner identity. */
export function findContactsForPartner(
    partnerName: string,
    contactsByPartner: Map<string, ComplianceContact[]>,
): ComplianceContact[] {
    const target = normalizeName(partnerName);
    if (contactsByPartner.has(target)) return contactsByPartner.get(target)!;

    let best: { key: string; score: number } | null = null;
    for (const key of contactsByPartner.keys()) {
        const score = diceCoefficient(target, key);
        if (score >= NAME_MATCH_THRESHOLD && (!best || score > best.score)) best = { key, score };
    }
    return best ? contactsByPartner.get(best.key)! : [];
}
