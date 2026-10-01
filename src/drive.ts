import { createReadStream, writeFileSync } from "fs";
import { google } from "googleapis";
import type { RunKind } from "./history.js";

const REGULAR_FOLDER_ID = "1zYBbtx2iCPL-ON3J16yK3pUEnI2Av1nR";
const QUARTERLY_FOLDER_ID = "18J_iSkLUIHqJOdoADLePGNf-CWdvKzNw";

function driveClient() {
    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!keyFile) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set");
    const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/drive"] });
    return google.drive({ version: "v3", auth });
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function mmddyyyy(date: Date): string {
    return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}/${date.getFullYear()}`;
}

function quarterOf(date: Date): number {
    return Math.floor(date.getMonth() / 3) + 1;
}

/** Matches the two naming conventions and folders confirmed with the team. */
export function reportDriveName(kind: RunKind, date: Date): string {
    const dateStr = mmddyyyy(date);
    if (kind === "quarterly") return `Draft Q${quarterOf(date)} ${date.getFullYear()} Full Partner Audit Report - ${dateStr}`;
    return `Partner Audit Report - ${dateStr}`;
}

export function reportDriveFolder(kind: RunKind): string {
    return kind === "quarterly" ? QUARTERLY_FOLDER_ID : REGULAR_FOLDER_ID;
}

export async function uploadReportToDrive(localFilePath: string, kind: RunKind, date: Date): Promise<string> {
    const drive = driveClient();
    const name = reportDriveName(kind, date);
    const folderId = reportDriveFolder(kind);
    const res = await drive.files.create({
        requestBody: { name, parents: [folderId] },
        media: {
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            body: createReadStream(localFilePath),
        },
        fields: "id,webViewLink",
        supportsAllDrives: true,
    });
    return res.data.webViewLink ?? `https://drive.google.com/file/d/${res.data.id}/view`;
}

function extractFileId(idOrUrl: string): string {
    const match = idOrUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) ?? idOrUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : idOrUrl;
}

export async function downloadReportFromDrive(idOrUrl: string, destPath: string): Promise<void> {
    const drive = driveClient();
    const fileId = extractFileId(idOrUrl);
    const res = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
    );
    writeFileSync(destPath, Buffer.from(res.data as ArrayBuffer));
}
