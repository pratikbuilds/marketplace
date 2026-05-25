import assert from "node:assert/strict";

import {
  buildAIPricingRulesPrompt,
  buildRule,
  createFriendlyRule,
  parseRulesJson,
  validateFriendlyRules,
  type FriendlyRule,
  type PricingRule,
} from "./pricing-rules";

function roundTrip(rule: FriendlyRule): FriendlyRule {
  return createFriendlyRule(buildRule(rule));
}

{
  const rule = createFriendlyRule();
  const next = roundTrip({
    ...rule,
    chargeTiming: "upfront",
    amountUsd: "0.025",
  });

  assert.equal(next.advancedRule, undefined);
  assert.equal(next.chargeTiming, "upfront");
  assert.equal(next.amountUsd, "0.025");
}

{
  const rule = createFriendlyRule();
  const next = roundTrip({
    ...rule,
    amountUsd: "0.0002",
    captureMode: "request-field",
    captureSource: "request-body",
    captureField: ".max_tokens",
    holdUsd: "1.50",
  });

  assert.equal(next.advancedRule, undefined);
  assert.equal(next.captureMode, "request-field");
  assert.equal(next.captureSource, "request-body");
  assert.equal(next.captureField, ".max_tokens");
  assert.equal(next.amountUsd, "0.0002");
  assert.equal(next.holdUsd, "1.5");
}

{
  const rule = createFriendlyRule();
  const next = roundTrip({
    ...rule,
    amountUsd: "0.000003",
    captureMode: "request-size",
    captureSource: "request-body",
    captureField: ".messages",
    holdUsd: "0.50",
  });

  assert.equal(next.advancedRule, undefined);
  assert.equal(next.captureMode, "request-size");
  assert.equal(next.captureSource, "request-body");
  assert.equal(next.captureField, ".messages");
  assert.equal(next.amountUsd, "0.000003");
}

{
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

  assert.equal(next.advancedRule, undefined);
  assert.equal(next.captureMode, "request-field");
  assert.equal(next.captureField, ".tokens");
  assert.equal(next.captureFallback, "1");
  assert.equal(next.authorizeMode, "request-size");
  assert.equal(next.authorizeField, ".messages");
  assert.equal(next.authorizeFallback, "[]");
}

{
  const rule: PricingRule = {
    match: "$",
    capture: "max($.request.body.tokens, 1) * 10000",
  };

  const next = createFriendlyRule(rule);

  assert.deepEqual(next.advancedRule, rule);
}

assert.deepEqual(parseRulesJson('[{"match":"$","capture":"10000"}]'), [
  { match: "$", capture: "10000" },
]);
assert.throws(
  () => parseRulesJson('[{"match":"$","capture":10000}]'),
  /Rule 1 requires capture/,
);

{
  const rule = createFriendlyRule();

  assert.equal(
    validateFriendlyRules([{ ...rule, holdUsd: "" }]),
    "Max upfront is required",
  );
}

{
  const currentRules = '[{"match":"$","capture":"10000"}]';
  const prompt = buildAIPricingRulesPrompt(currentRules);

  assert.match(prompt, /return only the final JSON/);
  assert.match(prompt, /Do not wrap the JSON in Markdown/);
  assert.match(prompt, /The final output must be a JSON array/);
  assert.match(prompt, /Do not use response fields in "match"/);
  assert.match(prompt, /Do not use response fields in "authorize"/);
  assert.match(
    prompt,
    /Current rules in my editor:\n\[\{"match":"\$","capture":"10000"\}\]/,
  );
}
