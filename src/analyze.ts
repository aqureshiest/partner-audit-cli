import {
    BedrockRuntimeClient,
    ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { ComplianceRule } from "./sheets.js";
import type { OfficialRate } from "./rates.js";

export const HAIKU_MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
export const SONNET_MODEL_ID = "global.anthropic.claude-sonnet-4-6";

// Bedrock pricing per million tokens
const PRICING: Record<string, { input: number; output: number }> = {
    [HAIKU_MODEL_ID]:  { input: 0.80,  output: 4.00 },
    [SONNET_MODEL_ID]: { input: 3.00,  output: 15.00 },
};

function makeClient(): BedrockRuntimeClient {
    const cfg: ConstructorParameters<typeof BedrockRuntimeClient>[0] = {
        region: process.env.AWS_REGION ?? "us-east-1",
    };
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
        cfg.token = { token: process.env.AWS_BEARER_TOKEN_BEDROCK };
    }
    return new BedrockRuntimeClient(cfg);
}

const client = makeClient();

export interface UrlResult {
    url: string;
    urlType: string;
    partnerName: string;
    violations: string[];
    status: "compliant" | "violations" | "warnings" | "blocked" | "error";
    error?: string;
    cost?: number;
    inputTokens?: number;
    outputTokens?: number;
}

function formatRules(rules: ComplianceRule[], urlType: string): string {
    const products = ["ALL", urlType === "SLR" ? "Student Loans Refinancing" : urlType === "SLO" ? "Student Loan Origination" : "Personal Loans"];
    const applicable = rules.filter((r) => products.includes(r.product));

    const high = applicable.filter((r) => r.riskLevel.toUpperCase().includes("HIGH"));
    const medium = applicable.filter((r) => r.riskLevel.toUpperCase().includes("MEDIUM"));

    const fmt = (list: ComplianceRule[]) =>
        list.map((r) => `- ${r.claim}${r.recommendation ? ` → ${r.recommendation}` : ""}`).join("\n");

    return `HIGH RISK:\n${fmt(high) || "  (none)"}\n\nMEDIUM RISK:\n${fmt(medium) || "  (none)"}`;
}

export async function analyzePage(
    content: string,
    urlType: string,
    partnerName: string,
    url: string,
    rules: ComplianceRule[],
    officialRates: OfficialRate[],
    modelId: string = HAIKU_MODEL_ID,
): Promise<UrlResult> {
    if (!content || content.length < 100) {
        return { url, urlType, partnerName, violations: [], status: "blocked", error: "No content", cost: 0 };
    }

    const officialRate = officialRates.find((r) => r.loanType === urlType);
    const rateContext = officialRate
        ? `Official Earnest ${urlType} rates today: Fixed ${officialRate.fixedLow}%–${officialRate.fixedHigh}%, Variable ${officialRate.variableLow}%–${officialRate.variableHigh}%`
        : "";

    const systemPrompt = `You are an Earnest compliance auditor reviewing a partner website page.
Only flag issues with Earnest-specific content. Ignore other lenders.

${rateContext}

COMPLIANCE RULES (apply only to Earnest content):
${formatRules(rules, urlType)}

INSTRUCTIONS:
1. Check for any compliance rule violations in Earnest-specific content
2. If rates are shown for Earnest, check they match official rates (±0.1% tolerance)
3. Check for required disclosures (lender ID, APR if rates shown, Reg-Z if loan terms shown)
4. For each issue found, output ONE line in this exact format:
   RISK_LEVEL - CATEGORY: <recommendation text from the rule, verbatim>
   Example: HIGH RISK - guarantees: Remove approval guarantee claim
5. If no Earnest content or no issues found, output: COMPLIANT

Output ONLY the issue lines or COMPLIANT. No explanations.`;

    try {
        const command = new ConverseCommand({
            modelId,
            system: [{ text: systemPrompt }],
            messages: [
                {
                    role: "user",
                    content: [{ text: `Page URL: ${url}\n\nPage content:\n${content.slice(0, 40000)}` }],
                },
            ],
            inferenceConfig: { maxTokens: 1024, temperature: 0 },
        });

        const response = await client.send(command);
        const text = response.output?.message?.content?.[0]?.text?.trim() ?? "";
        const lines = text.split("\n").map((l: string) => l.trim()).filter(Boolean);

        const inputTokens = response.usage?.inputTokens ?? 0;
        const outputTokens = response.usage?.outputTokens ?? 0;
        const pricing = PRICING[modelId] ?? { input: 0, output: 0 };
        const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

        if (lines[0] === "COMPLIANT" || lines.length === 0) {
            return { url, urlType, partnerName, violations: [], status: "compliant", cost, inputTokens, outputTokens };
        }

        const violations = lines.filter((l: string) => l.startsWith("HIGH") || l.startsWith("MEDIUM") || l.startsWith("LOW"));
        const hasHigh = violations.some((v: string) => v.startsWith("HIGH"));

        return {
            url,
            urlType,
            partnerName,
            violations,
            status: hasHigh ? "violations" : "warnings",
            cost,
            inputTokens,
            outputTokens,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { url, urlType, partnerName, violations: [], status: "error", error: message, cost: 0 };
    }
}
