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

  const capture = buildAmountExpression({
    mode: rule.captureMode,
    amountUsd: rule.amountUsd,
    source: rule.captureSource,
    field: rule.captureField,
    fallback: rule.captureFallback,
  });

  const built: PricingRule = {
    match: buildMatch(rule),
    capture,
  };
  if (rule.chargeTiming === "after-response") {
    built.authorize = buildAmountExpression({
      mode: rule.authorizeMode,
      amountUsd: rule.holdUsd,
      source: rule.authorizeSource,
      field: rule.authorizeField,
      fallback: rule.authorizeFallback,
    });
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
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Rule ${index + 1} must be an object`);
    }
    const raw = entry as Record<string, unknown>;
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

export function validateFriendlyRules(rules: FriendlyRule[]): string | null {
  for (const [index, rule] of rules.entries()) {
    if (rule.advancedRule) continue;

    const label = rules.length > 1 ? `Rule ${index + 1}: ` : "";
    const chargeError = validateUSDInput(rule.amountUsd);
    if (chargeError) {
      return `${label}${chargeError}`;
    }

    if (rule.chargeTiming === "after-response") {
      if (rule.holdUsd.trim() === "") {
        return `${label}Max upfront is required`;
      }
      const reserveError = validateUSDInput(rule.holdUsd);
      if (reserveError) {
        return `${label}${reserveError}`;
      }
    }
  }

  return null;
}

function parseAmountExpression(value: string | undefined): {
  amountUsd: string;
  mode: AmountMode;
  source: AmountFieldSource;
  field: string;
  fallback: string;
} | null {
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

  const ref = parseReference(match[1]?.trim() ?? "");
  if (!ref) {
    return null;
  }
  if (ref.source !== "request-body" && ref.source !== "response-body") {
    return null;
  }
  return {
    amountUsd: formatUsd(parseInt(match[2] ?? "0", 10)),
    mode: ref.source === "request-body" ? "request-field" : "response-field",
    source: ref.source,
    field: ref.field,
    fallback: "",
  };
}

function formatUsd(micro: number): string {
  return (micro / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}

function validateUSDInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "Enter a pricing amount";
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

function buildAmountExpression(args: {
  mode: AmountMode;
  amountUsd: string;
  source: AmountFieldSource;
  field: string;
  fallback: string;
}): string {
  const amount = usdToAtomic(args.amountUsd);
  if (args.mode === "fixed") {
    return `${amount}`;
  }

  const ref = fieldRef(args.source, args.field);
  const valueRef =
    args.fallback.trim() === ""
      ? ref
      : `coalesce(${ref}, ${args.fallback.trim()})`;
  if (args.mode === "request-size") {
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
