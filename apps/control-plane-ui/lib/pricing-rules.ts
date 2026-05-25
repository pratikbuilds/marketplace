export interface PricingRule {
  match: string;
  authorize?: string;
  capture: string;
}

export type MatchMode =
  | "every-request"
  | "request-field-equals"
  | "request-field-matches"
  | "request-field-exists";

export type RequestFieldSource =
  | "request-body"
  | "request-header"
  | "request-query"
  | "request-path";

export type AmountMode =
  | "fixed"
  | "request-field"
  | "request-size"
  | "response-field";

export type ChargeTiming = "upfront" | "after-response";

export type AmountFieldSource =
  | RequestFieldSource
  | "response-body"
  | "response-header"
  | "response-status";

export interface FriendlyRule {
  id: string;
  advancedRule?: PricingRule;
  matchMode: MatchMode;
  matchSource: RequestFieldSource;
  matchField: string;
  matchValue: string;
  amountUsd: string;
  authorizeMode: AmountMode;
  authorizeSource: AmountFieldSource;
  authorizeField: string;
  authorizeFallback: string;
  captureMode: AmountMode;
  captureSource: AmountFieldSource;
  captureField: string;
  captureFallback: string;
  chargeTiming: ChargeTiming;
  holdUsd: string;
}

type AmountConfig = {
  mode: AmountMode;
  amountUsd: string;
  source: AmountFieldSource;
  field: string;
  fallback: string;
};

export const matchModes: { value: MatchMode; label: string }[] = [
  { value: "every-request", label: "every request" },
  { value: "request-field-equals", label: "request field equals" },
  { value: "request-field-matches", label: "request field matches" },
  { value: "request-field-exists", label: "request field exists" },
];

export const reserveAmountModes: { value: AmountMode; label: string }[] = [
  { value: "fixed", label: "fixed reserve" },
  { value: "request-field", label: "per request field" },
  { value: "request-size", label: "per request size" },
];

export const chargeAmountModes: { value: AmountMode; label: string }[] = [
  { value: "fixed", label: "fixed charge" },
  { value: "request-field", label: "per request field" },
  { value: "request-size", label: "per request size" },
  { value: "response-field", label: "per response field" },
];

export function createFriendlyRule(
  rule?: PricingRule,
  index = 0,
): FriendlyRule {
  const friendly: FriendlyRule = {
    id: `${Date.now()}-${index}`,
    matchMode: "every-request",
    matchSource: "request-body",
    matchField: ".model",
    matchValue: "",
    amountUsd: "0.01",
    authorizeMode: "fixed",
    authorizeSource: "request-body",
    authorizeField: ".max_tokens",
    authorizeFallback: "",
    captureMode: "fixed",
    captureSource: "response-body",
    captureField: ".usage.total_tokens",
    captureFallback: "",
    chargeTiming: "after-response",
    holdUsd: "1",
  };

  if (!rule) {
    return friendly;
  }

  const match = parseMatch(rule.match);
  const capture = parseAmountExpression(rule.capture);
  const authorize = parseAmountExpression(rule.authorize);
  if (!match || !capture || (rule.authorize && !authorize)) {
    return {
      ...friendly,
      advancedRule: rule,
    };
  }

  return {
    ...friendly,
    ...match,
    amountUsd: capture.amountUsd,
    captureMode: capture.mode,
    captureSource: capture.source,
    captureField: formatEditablePath(capture.field),
    captureFallback: capture.fallback,
    authorizeMode: authorize?.mode ?? "fixed",
    authorizeSource: authorize?.source ?? "request-body",
    authorizeField: formatEditablePath(authorize?.field ?? ".max_tokens"),
    authorizeFallback: authorize?.fallback ?? "",
    chargeTiming: authorize ? "after-response" : "upfront",
    holdUsd: authorize?.amountUsd ?? "",
  };
}

export function createFriendlyRulesFromPricingRules(
  rules: PricingRule[],
): FriendlyRule[] {
  if (rules.length === 0) {
    return [createFriendlyRule()];
  }
  return rules.map((rule, index) => createFriendlyRule(rule, index));
}

export function buildRule(rule: FriendlyRule): PricingRule {
  if (rule.advancedRule) {
    return rule.advancedRule;
  }

  const built: PricingRule = {
    match: buildMatch(rule),
    capture: buildAmountExpression(getCaptureAmountConfig(rule)),
  };
  if (rule.chargeTiming === "after-response") {
    built.authorize = buildAmountExpression(getAuthorizeAmountConfig(rule));
  }
  return built;
}

export function buildRules(rules: FriendlyRule[]): PricingRule[] {
  return rules.map(buildRule);
}

export function buildRulesSummary(rules: FriendlyRule[]): string {
  const firstRule = rules[0] ?? createFriendlyRule();
  if (rules.length <= 1) {
    return buildSummary(firstRule);
  }
  return `${rules.length} rules configured. First rule: ${buildSummary(
    firstRule,
  )}`;
}

export function formatRulesJson(rules: PricingRule[]): string {
  return JSON.stringify(rules, null, 2);
}

export function parseRulesJson(value: string): PricingRule[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Technical rule must be a JSON array");
  }

  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Rule ${index + 1} must be an object`);
    }
    const raw = entry;
    if (typeof raw.match !== "string" || raw.match.trim() === "") {
      throw new Error(`Rule ${index + 1} requires match`);
    }
    if (typeof raw.capture !== "string" || raw.capture.trim() === "") {
      throw new Error(`Rule ${index + 1} requires capture`);
    }
    if (raw.authorize !== undefined && typeof raw.authorize !== "string") {
      throw new Error(`Rule ${index + 1} authorize must be a string`);
    }

    const rule: PricingRule = {
      match: raw.match.trim(),
      capture: raw.capture.trim(),
    };
    if (typeof raw.authorize === "string" && raw.authorize.trim() !== "") {
      rule.authorize = raw.authorize.trim();
    }
    return rule;
  });
}

export function buildAIPricingRulesPrompt(currentRulesJson: string): string {
  return `You are helping me create custom Faremeter Flex pricing rules.

Your job is to help me turn a pricing idea into valid JSON rules that I can paste into a pricing editor.

First, ask me any clarifying questions you need about the pricing behavior. Once you have enough information, return only the final JSON. Do not wrap the JSON in Markdown. Do not include explanations with the final JSON.

The final output must be a JSON array. Each rule must be an object with:
- "match": a required JSONPath string
- "capture": a required pricing expression string
- "authorize": an optional pricing expression string

How the rules work:
- Rules are checked from top to bottom.
- The first rule whose "match" expression matches the request wins.
- Use "$" to match every request.
- "match" can only use request data, such as request body, headers, query, or path.
- Do not use response fields in "match".
- "capture" is always required.
- If pricing depends on the upstream response, include "authorize" for the upfront maximum and use "capture" for the final amount.
- Do not use response fields in "authorize".
- If there is no "authorize", "capture" must only use request data.
- Pricing expressions can use +, -, *, /, parentheses, jsonSize(ref), and coalesce(ref, default).

Useful patterns:
- Match every request:
  { "match": "$", "capture": "10000" }

- Match a request body field:
  { "match": "$[?@.request.body.model == \\"gpt-4o\\"]", "capture": "10000" }

- Match a model family with regex:
  { "match": "$[?match(@.request.body.model, \\"claude-sonnet.*\\")]", "capture": "10000" }

- Charge from a request field:
  { "match": "$", "capture": "$.request.body.quantity * 1000" }

- Charge from response usage with an upfront maximum:
  {
    "match": "$",
    "authorize": "coalesce($.request.body.max_tokens, 1000) * 30",
    "capture": "$.response.body.usage.total_tokens * 30"
  }

Current rules in my editor:
${currentRulesJson.trim()}

Help me design the pricing behavior, then produce the final JSON array.`;
}

export function validateFriendlyRules(rules: FriendlyRule[]): string | null {
  for (const [index, rule] of rules.entries()) {
    if (rule.advancedRule) continue;

    const label = rules.length > 1 ? `Rule ${index + 1}: ` : "";
    const chargeError = validateAmountConfig(getCaptureAmountConfig(rule));
    if (chargeError) {
      return `${label}${chargeError}`;
    }

    if (rule.chargeTiming === "after-response") {
      const reserveError = validateAmountConfig(
        getAuthorizeAmountConfig(rule),
        "Max upfront is required",
      );
      if (reserveError) {
        return `${label}${reserveError}`;
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCaptureAmountConfig(rule: FriendlyRule): AmountConfig {
  return {
    mode: rule.captureMode,
    amountUsd: rule.amountUsd,
    source: rule.captureSource,
    field: rule.captureField,
    fallback: rule.captureFallback,
  };
}

function getAuthorizeAmountConfig(rule: FriendlyRule): AmountConfig {
  return {
    mode: rule.authorizeMode,
    amountUsd: rule.holdUsd,
    source: rule.authorizeSource,
    field: rule.authorizeField,
    fallback: rule.authorizeFallback,
  };
}

function validateAmountConfig(
  config: AmountConfig,
  emptyMessage = "Enter a pricing amount",
): string | null {
  return validateUSDInput(config.amountUsd, emptyMessage);
}

function parseAmountExpression(value: string | undefined): AmountConfig | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return {
      amountUsd: formatUsd(parseInt(trimmed, 10)),
      mode: "fixed",
      source: "response-body",
      field: "usage.total_tokens",
      fallback: "",
    };
  }

  const match = /^(.+?)\s*\*\s*(\d+)$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const parsedValueRef = parseAmountValueRef(match[1]?.trim() ?? "");
  if (!parsedValueRef) {
    return null;
  }

  const ref = parseReference(parsedValueRef.ref);
  if (!ref) {
    return null;
  }
  if (ref.source !== "request-body" && ref.source !== "response-body") {
    return null;
  }
  return {
    amountUsd: formatUsd(parseInt(match[2] ?? "0", 10)),
    mode: parsedValueRef.usesSize
      ? "request-size"
      : ref.source === "request-body"
        ? "request-field"
        : "response-field",
    source: ref.source,
    field: ref.field,
    fallback: parsedValueRef.fallback,
  };
}

function parseAmountValueRef(value: string): {
  ref: string;
  fallback: string;
  usesSize: boolean;
} | null {
  const sizeMatch = /^jsonSize\((.+)\)$/.exec(value);
  if (sizeMatch?.[1]) {
    const parsed = parseAmountValueRef(sizeMatch[1].trim());
    if (!parsed) {
      return null;
    }
    return { ...parsed, usesSize: true };
  }

  const coalesceMatch = /^coalesce\((.+),\s*(.+)\)$/.exec(value);
  if (coalesceMatch?.[1] && coalesceMatch[2]) {
    return {
      ref: coalesceMatch[1].trim(),
      fallback: coalesceMatch[2].trim(),
      usesSize: false,
    };
  }

  return { ref: value, fallback: "", usesSize: false };
}

function formatUsd(micro: number): string {
  return (micro / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}

function validateUSDInput(
  value: string,
  emptyMessage = "Enter a pricing amount",
): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return emptyMessage;
  }
  if (!/^\d*\.?\d+$/.test(trimmed)) {
    return "Pricing amounts must be numeric";
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "Pricing amounts must be zero or greater";
  }
  return null;
}

function usdToAtomic(value: string): number {
  const error = validateUSDInput(value);
  if (error) {
    throw new Error(error);
  }
  return Math.round(Number(value.trim()) * 1_000_000);
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function jsonPathString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function parseJsonPathString(value: string): string {
  const quote = value[0];
  if (quote === '"') {
    return JSON.parse(value) as string;
  }
  return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

function splitFieldPath(value: string): string[] {
  return value
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function formatEditablePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith(".") || trimmed.startsWith("[")) {
    return trimmed;
  }
  return `.${trimmed}`;
}

function appendFieldPath(base: string, field: string): string {
  return splitFieldPath(field).reduce((current, part) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
      return `${current}.${part}`;
    }
    return `${current}[${jsonString(part)}]`;
  }, base);
}

function fieldRef(source: AmountFieldSource, field: string): string {
  switch (source) {
    case "request-body":
      return appendFieldPath("$.request.body", field);
    case "request-header":
      return appendFieldPath("$.request.headers", field);
    case "request-query":
      return appendFieldPath("$.request.query", field);
    case "request-path":
      return "$.request.path";
    case "response-body":
      return appendFieldPath("$.response.body", field);
    case "response-header":
      return appendFieldPath("$.response.headers", field);
    case "response-status":
      return "$.response.status";
  }
}

function matchRef(source: RequestFieldSource, field: string): string {
  return fieldRef(source, field).replace(/^\$/, "@");
}

function parseReference(
  ref: string,
): { source: AmountFieldSource; field: string } | null {
  const normalized = ref.trim();
  const mappings: [string, AmountFieldSource][] = [
    ["$.request.body.", "request-body"],
    ["$.request.headers.", "request-header"],
    ["$.request.query.", "request-query"],
    ["$.response.body.", "response-body"],
    ["$.response.headers.", "response-header"],
  ];

  if (normalized === "$.request.path") {
    return { source: "request-path", field: "" };
  }
  if (normalized === "$.response.status") {
    return { source: "response-status", field: "" };
  }

  for (const [prefix, source] of mappings) {
    if (normalized.startsWith(prefix)) {
      return { source, field: normalized.slice(prefix.length) };
    }
  }

  return null;
}

function parseMatch(match: string): Partial<FriendlyRule> | null {
  const trimmed = match.trim();
  if (trimmed === "$") {
    return { matchMode: "every-request" };
  }

  const exists =
    /^\$\[\?(@\.request\.(?:body|headers|query)(?:\.[^\]]+))\]$/.exec(trimmed);
  if (exists?.[1]) {
    const parsed = parseReference(exists[1].replace(/^@/, "$"));
    if (parsed?.source === "request-body") {
      return {
        matchMode: "request-field-exists",
        matchSource: parsed.source,
        matchField: formatEditablePath(parsed.field),
      };
    }
  }

  const equals =
    /^\$\[\?(@\.request\.(?:body|headers|query)(?:\.[^\]]+)|@\.request\.path) == ((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*'))\]$/.exec(
      trimmed,
    );
  if (equals?.[1] && equals[2]) {
    const parsed = parseReference(equals[1].replace(/^@/, "$"));
    if (parsed?.source === "request-body") {
      return {
        matchMode: "request-field-equals",
        matchSource: parsed.source,
        matchField: formatEditablePath(parsed.field),
        matchValue: parseJsonPathString(equals[2]),
      };
    }
  }

  const matches =
    /^\$\[\?match\((@\.request\.(?:body|headers|query)(?:\.[^\]]+)|@\.request\.path), ((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*'))\)\]$/.exec(
      trimmed,
    );
  if (matches?.[1] && matches[2]) {
    const parsed = parseReference(matches[1].replace(/^@/, "$"));
    if (parsed?.source === "request-body") {
      return {
        matchMode: "request-field-matches",
        matchSource: parsed.source,
        matchField: formatEditablePath(parsed.field),
        matchValue: parseJsonPathString(matches[2]),
      };
    }
  }

  return null;
}

function buildMatch(rule: FriendlyRule): string {
  if (rule.matchMode === "every-request") {
    return "$";
  }

  const ref = matchRef(rule.matchSource, rule.matchField);
  if (rule.matchMode === "request-field-exists") {
    return `$[?${ref}]`;
  }
  if (rule.matchMode === "request-field-matches") {
    return `$[?match(${ref}, ${jsonPathString(rule.matchValue)})]`;
  }
  return `$[?${ref} == ${jsonPathString(rule.matchValue)}]`;
}

function buildAmountExpression(config: AmountConfig): string {
  const amount = usdToAtomic(config.amountUsd);
  if (config.mode === "fixed") {
    return `${amount}`;
  }

  const ref = fieldRef(config.source, config.field);
  const valueRef =
    config.fallback.trim() === ""
      ? ref
      : `coalesce(${ref}, ${config.fallback.trim()})`;
  if (config.mode === "request-size") {
    return `jsonSize(${valueRef}) * ${amount}`;
  }
  return `${valueRef} * ${amount}`;
}

function formatUSD(value: string): string {
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return "$0";
  }
  return `$${parsed.toLocaleString(undefined, {
    maximumFractionDigits: 6,
  })}`;
}

function fieldLabel(source: AmountFieldSource, field: string): string {
  const path = field.trim();
  switch (source) {
    case "request-body":
      return path ? `request ${path}` : "request";
    case "request-header":
      return path ? `request header ${path}` : "request header";
    case "request-query":
      return path ? `request query ${path}` : "request query";
    case "request-path":
      return "request path";
    case "response-body":
      return path ? `response ${path}` : "response";
    case "response-header":
      return path ? `response header ${path}` : "response header";
    case "response-status":
      return "response status";
  }
}

function buildSummary(rule: FriendlyRule): string {
  if (rule.advancedRule) {
    return "This endpoint uses an advanced pricing rule.";
  }

  const unit =
    rule.captureMode === "fixed"
      ? "request"
      : fieldLabel(rule.captureSource, rule.captureField);
  const hold = rule.holdUsd.trim();
  if (
    rule.chargeTiming === "upfront" ||
    !hold ||
    validateUSDInput(hold) ||
    usdToAtomic(hold) === 0
  ) {
    return `Charge ${formatUSD(rule.amountUsd)} per ${unit} upfront.`;
  }
  return `Charge ${formatUSD(
    rule.amountUsd,
  )} per ${unit} after the response, with max upfront ${formatUSD(hold)}.`;
}
