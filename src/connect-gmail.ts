#!/usr/bin/env tsx
import { connectGmail } from "./gmail.js";

const clientSecretPath = process.argv[2];
if (!clientSecretPath) {
    console.error('Usage: npm run connect-gmail -- "/path/to/client_secret_....json"');
    process.exit(1);
}

connectGmail(clientSecretPath).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
