#!/usr/bin/env tsx
/**
 * Sends an existing Gmail draft as-is — run only after you've reviewed it in Gmail.
 * Usage: npm run send-draft -- "<draft id>"
 */
import { config } from "dotenv";
config();

import { sendGmailDraft } from "./gmail.js";

const draftId = process.argv[2];
if (!draftId) {
    console.error('Usage: npm run send-draft -- "<draft id>"');
    process.exit(1);
}

sendGmailDraft(draftId)
    .then(() => console.log(`Sent draft ${draftId}.`))
    .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
