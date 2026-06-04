import { chromium, type Browser, type BrowserContext } from "playwright";
import { compile } from "html-to-text";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface ScrapedPage {
    url: string;
    content: string;
    error?: string;
}

interface CacheEntry {
    url: string;
    content: string;
    error?: string;
    cachedAt: number;
}

const CACHE_DIR = ".scrape-cache";
const CACHE_TTL_MS = 15 * 60 * 1000;

function cacheKey(url: string): string {
    return createHash("sha256").update(url).digest("hex");
}

function readCache(url: string): ScrapedPage | null {
    const file = join(CACHE_DIR, `${cacheKey(url)}.json`);
    if (!existsSync(file)) return null;
    try {
        const entry: CacheEntry = JSON.parse(readFileSync(file, "utf8"));
        if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
        return { url: entry.url, content: entry.content, error: entry.error };
    } catch {
        return null;
    }
}

function writeCache(page: ScrapedPage): void {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR);
    const entry: CacheEntry = { ...page, cachedAt: Date.now() };
    writeFileSync(join(CACHE_DIR, `${cacheKey(page.url)}.json`), JSON.stringify(entry));
}

const htmlToText = compile({
    wordwrap: false,
    selectors: [
        { selector: "script", format: "skip" },
        { selector: "style", format: "skip" },
        { selector: "nav", format: "skip" },
        { selector: "footer", format: "skip" },
        { selector: "aside", format: "skip" },
        { selector: ".cookie-banner", format: "skip" },
        { selector: ".advertisement", format: "skip" },
    ],
});

function cleanText(text: string): string {
    return text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^\s+|\s+$/g, "")
        .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "");
}

export async function scrapeUrls(urls: string[]): Promise<ScrapedPage[]> {
    const chromePath = process.env.CHROME_PATH;
    const headless = process.env.HEADLESS !== "false";

    // Serve cached pages immediately, collect only uncached URLs
    const results: (ScrapedPage | null)[] = urls.map((url) => {
        const cached = readCache(url);
        if (cached) {
            console.log(`  [cached] ${url}`);
            return cached;
        }
        return null;
    });

    const uncachedIndices = results
        .map((r, i) => (r === null ? i : null))
        .filter((i): i is number => i !== null);

    if (uncachedIndices.length === 0) {
        return results as ScrapedPage[];
    }

    // Launch browser only if there are uncached URLs
    const browser: Browser = await chromium.launch({
        channel: chromePath ? undefined : "chrome",
        executablePath: chromePath,
        headless,
        args: [
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
        ],
    });

    const context: BrowserContext = await browser.newContext({
        userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 900 },
        javaScriptEnabled: true,
    });

    for (const i of uncachedIndices) {
        const url = urls[i];
        const page = await context.newPage();
        try {
            console.log(`  Scraping ${url}`);
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
            await page.waitForTimeout(3000);

            const html = await page.content();
            const scraped: ScrapedPage = { url, content: cleanText(htmlToText(html)) };
            writeCache(scraped);
            results[i] = scraped;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`  Failed to scrape ${url}: ${message}`);
            const scraped: ScrapedPage = { url, content: "", error: message };
            writeCache(scraped);
            results[i] = scraped;
        } finally {
            await page.close();
        }
    }

    await context.close();
    await browser.close();

    return results as ScrapedPage[];
}
