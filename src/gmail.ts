import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/gmail.compose"];
const TOKEN_PATH = "gmail-token.json";

interface ClientSecretFile {
    installed: { client_id: string; client_secret: string };
}

function openBrowser(url: string): void {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const args = process.platform === "win32" ? ["", url] : [url];
    const shell = process.platform === "win32";
    spawn(command, args, { detached: true, stdio: "ignore", shell }).unref();
}

/**
 * One-time interactive flow: opens the browser for the user to approve Gmail
 * draft access, then saves a refresh token locally (gitignored) so future
 * runs don't need to re-approve.
 */
export async function connectGmail(clientSecretPath: string): Promise<void> {
    const { installed } = JSON.parse(readFileSync(clientSecretPath, "utf-8")) as ClientSecretFile;

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}`;

    const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret, redirectUri);
    const authUrl = oauth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });

    console.log("Opening your browser to approve Gmail draft access...");
    console.log(`If it doesn't open automatically, visit:\n${authUrl}\n`);
    openBrowser(authUrl);

    const code = await new Promise<string>((resolve, reject) => {
        server.on("request", (req, res) => {
            const url = new URL(req.url ?? "", redirectUri);
            const code = url.searchParams.get("code");
            const error = url.searchParams.get("error");
            res.setHeader("Content-Type", "text/html");
            if (code) {
                res.end("<h2>Gmail connected — you can close this tab and return to the terminal.</h2>");
                resolve(code);
            } else {
                res.end(`<h2>Something went wrong: ${error ?? "no code returned"}. You can close this tab.</h2>`);
                reject(new Error(error ?? "No authorization code returned"));
            }
        });
    });
    server.close();

    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
        throw new Error(
            "Google didn't return a refresh token. This usually means Gmail was already " +
            "approved once before with this account — go to https://myaccount.google.com/permissions, " +
            "remove access for this app, and run this command again.",
        );
    }

    writeFileSync(
        TOKEN_PATH,
        JSON.stringify({ clientId: installed.client_id, clientSecret: installed.client_secret, refreshToken: tokens.refresh_token }, null, 2),
    );
    console.log(`\nGmail connected. Drafts will be created in this account from now on (token saved to ${TOKEN_PATH}).`);
}

export interface GmailSetupStatus {
    connected: boolean;
    /** Plain-language steps to fix it, ready to print or drop into an SOP. */
    fixSteps: string[];
}

export function checkGmailSetup(): GmailSetupStatus {
    if (!existsSync(TOKEN_PATH)) {
        return {
            connected: false,
            fixSteps: [
                "Gmail isn't connected on this machine yet.",
                "1. Get the Gmail OAuth client JSON file from whoever set up this tool's Google Cloud project (or create one yourself — see the project README).",
                '2. Run: npm run connect-gmail -- "/path/to/client_secret_....json"',
                "3. Approve access in the browser tab that opens.",
                "Drafts will then be created in whichever Google account you approve with.",
            ],
        };
    }
    return { connected: true, fixSteps: [] };
}

function loadGmailClient(): OAuth2Client {
    const { clientId, clientSecret, refreshToken } = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
    const client = new google.auth.OAuth2(clientId, clientSecret);
    client.setCredentials({ refresh_token: refreshToken });
    return client;
}

function encodeMimeMessage(to: string, subject: string, body: string): string {
    const message = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
    return Buffer.from(message).toString("base64url");
}

export async function createGmailDraft(to: string, subject: string, body: string): Promise<void> {
    const auth = loadGmailClient();
    const gmail = google.gmail({ version: "v1", auth });
    await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw: encodeMimeMessage(to, subject, body) } },
    });
}
