#!/usr/bin/env pnpm tsx

import t from "tap";

import {
  buildAIPricingRulesPrompt,
  buildRule,
  createFriendlyRule,
  parseRulesJson,
  validateFriendlyRules,
  type FriendlyRule,
  type PricingRule,
} from "../../apps/control-plane-ui/lib/pricing-rules";

function roundTrip(rule: FriendlyRule): FriendlyRule {
  return createFriendlyRule(buildRule(rule));
}

await t.test("pricing rule helper round trips fixed upfront charges", (t) => {
  const rule = createFriendlyRule();
  const next = roundTrip({
    ...rule,
    chargeTiming: "upfront",
    amountUsd: "0.025",
  });

  t.equal(next.advancedRule, undefined);
  t.equal(next.chargeTiming, "upfront");
  t.equal(next.amountUsd, "0.025");
  t.end();
});

await t.test("pricing rule helper round trips request field charges", (t) => {
  const rule = createFriendlyRule();
  const next = roundTrip({
    ...rule,
    amountUsd: "0.0002",
    captureMode: "request-field",
    captureSource: "request-body",
    captureField: ".max_tokens",
    holdUsd: "1.50",
  });

  t.equal(next.advancedRule, undefined);
  t.equal(next.captureMode, "request-field");
  t.equal(next.captureSource, "request-body");
  t.equal(next.captureField, ".max_tokens");
  t.equal(next.amountUsd, "0.0002");
  t.equal(next.holdUsd, "1.5");
  t.end();
});

await t.test("pricing rule helper round trips request size charges", (t) => {
  const rule = createFriendlyRule();
  const next = roundTrip({
    ...rule,
    amountUsd: "0.000003",
    captureMode: "request-size",
    captureSource: "request-body",
    captureField: ".messages",
    holdUsd: "0.50",
  });

  t.equal(next.advancedRule, undefined);
  t.equal(next.captureMode, "request-size");
  t.equal(next.captureSource, "request-body");
  t.equal(next.captureField, ".messages");
  t.equal(next.amountUsd, "0.000003");
  t.end();
});

await t.test(
  "pricing rule helper round trips authorize and capture rules",
  (t) => {
    const rule = createFriendlyRule();
    const next = roundTrip({
      ...rule,
      amountUsd: "0.01",
      captureMode: "request-field",
      captureSource: "request-body",
      captureField: ".tokens",
      captureFallback: "1",
      authorizeMode: "request-size",
      authorizeSource: "request-body",
      authorizeField: ".messages",
      authorizeFallback: "[]",
      holdUsd: "0.02",
    });

    t.equal(next.advancedRule, undefined);
    t.equal(next.captureMode, "request-field");
    t.equal(next.captureField, ".tokens");
    t.equal(next.captureFallback, "1");
    t.equal(next.authorizeMode, "request-size");
    t.equal(next.authorizeField, ".messages");
    t.equal(next.authorizeFallback, "[]");
    t.end();
  },
);

await t.test("pricing rule helper preserves advanced rules", (t) => {
  const rule: PricingRule = {
    match: "$",
    capture: "max($.request.body.tokens, 1) * 10000",
  };

  const next = createFriendlyRule(rule);

  t.matchOnly(next.advancedRule, rule);
  t.end();
});

await t.test("pricing rule JSON parsing validates rule shape", (t) => {
  t.matchOnly(parseRulesJson('[{"match":"$","capture":"10000"}]'), [
    { match: "$", capture: "10000" },
  ]);
  t.throws(
    () => parseRulesJson('[{"match":"$","capture":10000}]'),
    /Rule 1 requires capture/,
  );
  t.end();
});

await t.test("pricing rule friendly validation requires upfront hold", (t) => {
  const rule = createFriendlyRule();

  t.equal(
    validateFriendlyRules([{ ...rule, holdUsd: "" }]),
    "Max upfront is required",
  );
  t.end();
});

await t.test("pricing rule AI prompt includes editor constraints", (t) => {
  const currentRules = '[{"match":"$","capture":"10000"}]';
  const prompt = buildAIPricingRulesPrompt(currentRules);

  t.match(prompt, /return only the final JSON/);
  t.match(prompt, /Do not wrap the JSON in Markdown/);
  t.match(prompt, /The final output must be a JSON array/);
  t.match(prompt, /Do not use response fields in "match"/);
  t.match(prompt, /Do not use response fields in "authorize"/);
  t.match(
    prompt,
    /Current rules in my editor:\n\[\{"match":"\$","capture":"10000"\}\]/,
  );
  t.end();
});
