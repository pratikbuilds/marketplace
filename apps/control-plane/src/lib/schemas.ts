import { type } from "arktype";

export const MAX_NAME_LENGTH = 100;
export const MIN_ORG_NAME_LENGTH = 4;
export const MAX_ORG_NAME_LENGTH = 58; // 63 (DNS limit) - 5 (for "-xxxx" suffix)
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_AUTH_HEADER_LENGTH = 256;
export const MAX_AUTH_VALUE_LENGTH = 2048;
export const MAX_PATH_LENGTH = 2048;
export const MAX_IP_LENGTH = 45;
export const MAX_PUBKEY_LENGTH = 256;
export const MIN_PRICE = 1; // $0.000001 in micro-units (minimum non-free price)
export const MAX_PRICE = 100000000; // $100 in micro-units
export const MAX_PRIORITY = 10000;
export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 50;
export const MAX_BACKEND_URL_LENGTH = 2048;
export const DEFAULT_TENANT_SCHEME = "flex";

const tagType = type(`string > 0 & string <= ${MAX_TAG_LENGTH}`).narrow(
  (s, ctx) => {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(s)) {
      return ctx.mustBe(
        "lowercase alphanumeric, starting with letter or number, containing only letters, numbers, hyphens, and underscores",
      );
    }
    return true;
  },
);

const tagsArrayType = tagType.array().narrow((arr, ctx) => {
  if (arr.length > MAX_TAGS) {
    return ctx.mustBe(`at most ${MAX_TAGS} tags`);
  }
  if (new Set(arr).size !== arr.length) {
    return ctx.mustBe("unique (no duplicates)");
  }
  return true;
});

const pricingRuleType = type({
  match: "string > 0",
  "authorize?": "string > 0",
  capture: "string > 0",
});

export const PricingRulesPayloadSchema = type({
  rules: pricingRuleType.array(),
});

const backendUrlType = type(
  `string > 0 & string <= ${MAX_BACKEND_URL_LENGTH}`,
).narrow((s, ctx) => {
  const trimmed = s.trim();
  if (trimmed !== s) {
    return ctx.mustBe("a URL without leading or trailing whitespace");
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return ctx.mustBe("an http:// or https:// URL");
    }
  } catch {
    return ctx.mustBe("a valid URL");
  }
  return true;
});

export const CreateEndpointSchema = type({
  path: "string > 0",
  "path_pattern?": "string",
  "price?": `0 <= number <= ${MAX_PRICE} | null`,
  "scheme?": "'exact' | 'flex' | null",
  "description?": `string <= ${MAX_DESCRIPTION_LENGTH} | null`,
  "priority?": `0 <= number <= ${MAX_PRIORITY}`,
  "http_method?":
    "'ANY' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'",
  "openapi_source_paths?": "string[] | null",
  "pricing_rules?": pricingRuleType.array(),
  "tags?": tagsArrayType,
});

export const UpdateEndpointSchema = type({
  "path?": "string > 0",
  "price?": `0 <= number <= ${MAX_PRICE} | null`,
  "scheme?": "'exact' | 'flex' | null",
  "description?": `string <= ${MAX_DESCRIPTION_LENGTH} | null`,
  "priority?": `0 <= number <= ${MAX_PRIORITY}`,
  "http_method?":
    "'ANY' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'",
  "is_active?": "boolean",
  "openapi_source_paths?": "string[] | null",
  "pricing_rules?": pricingRuleType.array(),
  "tags?": tagsArrayType,
});

export const CreateTenantSchema = type({
  name: "string > 0",
  backend_url: backendUrlType,
  "wallet_id?": "number | null",
  "default_price?": `0 <= number <= ${MAX_PRICE}`,
  "default_scheme?": "'exact' | 'flex' | null",
  "upstream_auth_header?": `string <= ${MAX_AUTH_HEADER_LENGTH} | null`,
  "upstream_auth_value?": `string <= ${MAX_AUTH_VALUE_LENGTH} | null`,
  "is_active?": "boolean",
  "organization_id?": "number | null",
  "register_only?": "boolean",
  "tags?": tagsArrayType,
});

export const UpdateTenantSchema = type({
  "name?": "string > 0",
  "backend_url?": backendUrlType.or(type("null")),
  "organization_id?": "number | null",
  "wallet_id?": "number | null",
  "default_price?": `0 <= number <= ${MAX_PRICE}`,
  "default_scheme?": "'exact' | 'flex' | null",
  "upstream_auth_header?": `string <= ${MAX_AUTH_HEADER_LENGTH} | null`,
  "upstream_auth_value?": `string <= ${MAX_AUTH_VALUE_LENGTH} | null`,
  "is_active?": "boolean",
  "tags?": tagsArrayType,
});

export const CreateNodeSchema = type({
  name: `string <= ${MAX_NAME_LENGTH}`,
  internal_ip: `string <= ${MAX_IP_LENGTH}`,
  "public_ip?": `string <= ${MAX_IP_LENGTH} | null`,
  "status?": "'active' | 'inactive'",
  "wireguard_public_key?": `string <= ${MAX_PUBKEY_LENGTH} | null`,
  "wireguard_address?": `string <= ${MAX_IP_LENGTH} | null`,
});

export const UpdateNodeSchema = type({
  "name?": `string <= ${MAX_NAME_LENGTH}`,
  "internal_ip?": `string <= ${MAX_IP_LENGTH}`,
  "public_ip?": `string <= ${MAX_IP_LENGTH} | null`,
  "status?": "'active' | 'inactive'",
  "wireguard_public_key?": `string <= ${MAX_PUBKEY_LENGTH} | null`,
  "wireguard_address?": `string <= ${MAX_IP_LENGTH} | null`,
});

export const CreateWalletSchema = type({
  name: `string > 0 & string <= ${MAX_NAME_LENGTH}`,
  wallet_config: "unknown",
});

export const UpdateWalletSchema = type({
  "name?": `string <= ${MAX_NAME_LENGTH}`,
  "wallet_config?": "unknown",
});

export const OrgCreateTenantSchema = type({
  name: "string > 0",
  backend_url: backendUrlType,
  "wallet_id?": "number | null",
  "default_price?": `0 <= number <= ${MAX_PRICE}`,
  "default_scheme?": "'exact' | 'flex' | null",
  "upstream_auth_header?": `string <= ${MAX_AUTH_HEADER_LENGTH} | null`,
  "upstream_auth_value?": `string <= ${MAX_AUTH_VALUE_LENGTH} | null`,
  "register_only?": "boolean",
  "pricing_rules?": pricingRuleType.array(),
});

export const OrgUpdateTenantSchema = type({
  "name?": "string > 0",
  "backend_url?": backendUrlType.or(type("null")),
  "wallet_id?": "number | null",
  "default_price?": `0 <= number <= ${MAX_PRICE}`,
  "default_scheme?": "'exact' | 'flex' | null",
  "upstream_auth_header?": `string <= ${MAX_AUTH_HEADER_LENGTH} | null`,
  "upstream_auth_value?": `string <= ${MAX_AUTH_VALUE_LENGTH} | null`,
  "is_active?": "boolean",
});

export const AddMemberSchema = type({
  email: "string.email",
  "role?": "'owner' | 'admin' | 'member'",
});

export const UpdateMemberSchema = type({
  role: "'owner' | 'admin' | 'member'",
});

export const AdminCreateTenantSchema = type({
  name: "string > 0",
  backend_url: backendUrlType,
  "wallet_id?": "number | null",
  "organization_id?": "number | null",
  "node_id?": "number | null",
  "node_ids?": "number[]",
  "default_price?": `0 <= number <= ${MAX_PRICE}`,
  "default_scheme?": "'exact' | 'flex' | null",
  "upstream_auth_header?": `string <= ${MAX_AUTH_HEADER_LENGTH} | null`,
  "upstream_auth_value?": `string <= ${MAX_AUTH_VALUE_LENGTH} | null`,
  "register_only?": "boolean",
  "tags?": tagsArrayType,
  "pricing_rules?": pricingRuleType.array(),
});

const orgSlug = type(
  `string >= ${MIN_ORG_NAME_LENGTH} & string <= ${MAX_ORG_NAME_LENGTH}`,
).narrow((s, ctx) => {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(s)) {
    return ctx.mustBe(
      "lowercase alphanumeric, starting and ending with letter or number",
    );
  }
  return true;
});

const adminOrgSlug = orgSlug.or(type("null | ''"));

export const AdminUpdateTenantSchema = type({
  "name?": "string > 0",
  "backend_url?": backendUrlType.or(type("null")),
  "organization_id?": "number | null",
  "wallet_id?": "number | null",
  "default_price?": `0 <= number <= ${MAX_PRICE}`,
  "default_scheme?": "'exact' | 'flex' | null",
  "is_active?": "boolean",
  "upstream_auth_header?": `string <= ${MAX_AUTH_HEADER_LENGTH} | null`,
  "upstream_auth_value?": `string <= ${MAX_AUTH_VALUE_LENGTH} | null`,
  "org_slug?": adminOrgSlug,
  "tags?": tagsArrayType,
});

export const AdminUpdateEndpointSchema = type({
  "path?": `string <= ${MAX_PATH_LENGTH}`,
  "price?": `0 <= number <= ${MAX_PRICE} | null`,
  "scheme?": "'exact' | 'flex' | null",
  "description?": `string <= ${MAX_DESCRIPTION_LENGTH} | null`,
  "priority?": `0 <= number <= ${MAX_PRIORITY}`,
  "http_method?":
    "'ANY' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'",
  "pricing_rules?": pricingRuleType.array(),
  "tags?": tagsArrayType,
});

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export const SignupSchema = type({
  email: "string.email",
  password: `string >= ${MIN_PASSWORD_LENGTH} & string <= ${MAX_PASSWORD_LENGTH}`,
});

export const LoginSchema = type({
  email: "string.email",
  password: `string > 0 & string <= ${MAX_PASSWORD_LENGTH}`,
});

export const VerifyEmailSchema = type({
  token: "string > 0",
});

export const UpdatePasswordSchema = type({
  current_password: `string > 0 & string <= ${MAX_PASSWORD_LENGTH}`,
  new_password: `string >= ${MIN_PASSWORD_LENGTH} & string <= ${MAX_PASSWORD_LENGTH}`,
});

const ORG_NAME_PATTERN = /^[a-zA-Z0-9 .-]+$/;
const MAX_SLUG_LENGTH = 63;

const orgName = type(
  `string >= ${MIN_ORG_NAME_LENGTH} & string <= ${MAX_ORG_NAME_LENGTH}`,
).narrow((s, ctx) => {
  if (!ORG_NAME_PATTERN.test(s)) {
    return ctx.mustBe(
      "containing only letters, numbers, spaces, hyphens, and periods",
    );
  }
  if (/ {2}/.test(s)) {
    return ctx.mustBe("without consecutive spaces");
  }
  if (/\.{2}/.test(s)) {
    return ctx.mustBe("without consecutive periods");
  }
  if (s.startsWith("-")) {
    return ctx.mustBe("not starting with a hyphen");
  }
  if (s.endsWith("-")) {
    return ctx.mustBe("not ending with a hyphen");
  }
  if (s.startsWith(".")) {
    return ctx.mustBe("not starting with a period");
  }
  if (s.endsWith(".")) {
    return ctx.mustBe("not ending with a period");
  }
  return true;
});

export const CreateOrganizationSchema = type({
  name: orgName,
  "slug?": orgSlug.or(type("undefined")),
});

export const AdminImportOrgsSchema = type({
  names: orgName.array(),
  "skip_duplicates?": "boolean",
});

export const UpdateOrganizationSchema = type({
  "name?": orgName.or(type("undefined")),
  "slug?": orgSlug.or(type("undefined")),
});

export const AssignNodeSchema = type({
  node_id: "number",
  "is_primary?": "boolean",
});

export const WaitlistSchema = type({
  email: "string.email",
});

export const AdminUpdateUserSchema = type({
  "is_admin?": "boolean",
  "email_verified?": "boolean",
});

export const AdminUpdateSettingsSchema = type({
  "wallet_config?": "unknown | null",
  "minimum_balance_sol?": "0.001 <= number <= 1",
  "minimum_balance_usdc?": "0.001 <= number <= 100",
});

export const InternalTransactionSchema = type({
  ngx_request_id: `string > 0 & string <= ${MAX_NAME_LENGTH}`,
  tenant_name: `string > 0 & string <= ${MAX_SLUG_LENGTH}`,
  "org_slug?": `string <= ${MAX_SLUG_LENGTH} | null`,
  "endpoint_id?": "number | null",
  amount: "number >= 0",
  "tx_hash?": `string <= ${MAX_NAME_LENGTH} | null`,
  "network?": "string <= 50 | null",
  "token_symbol?": "string <= 20 | null",
  "mint_address?": "string <= 100 | null",
  request_path: `string > 0 & string <= ${MAX_PATH_LENGTH}`,
  "client_ip?": `string <= ${MAX_IP_LENGTH} | null`,
  "request_method?": "string <= 10 | null",
  "metadata?": "object | null",
});

// USD-pegged tokens whose price should follow the default_price
// EURC and any future non-USD tokens must NOT be in this list
export const USD_PEGGED_SYMBOLS = [
  "USDC",
  "USDT",
  "PYUSD",
  "USDG",
  "USD1",
  "USX",
  "CASH",
  "JupUSD",
  "USDS",
  "USDtb",
  "USDu",
  "USDGO",
  "FDUSD",
] as const;

export const CreateTokenPriceSchema = type({
  token_symbol: "string > 0 & string <= 20",
  mint_address: "string > 0 & string <= 100",
  network:
    "'solana-mainnet-beta' | 'solana-devnet' | 'base' | 'polygon' | 'eip155:137' | 'eip155:143'",
  amount: "number.integer >= 0",
  "decimals?": "0 <= number.integer <= 18",
  "endpoint_id?": "number.integer > 0 | null",
});

export const UpdateTokenPriceSchema = type({
  "amount?": "number.integer >= 0",
  "decimals?": "0 <= number.integer <= 18",
});

export const AdminAssignNodeSchema = type({
  node_id: "number",
});

export const OpenApiImportSchema = type({
  spec: "unknown",
});

export const OpenApiExtensionsSchema = type({
  "price?": `0 <= number <= ${MAX_PRICE} | null`,
  "scheme?": "'exact' | 'flex' | null",
  "tags?": tagsArrayType,
});

export const ValidatePatternSchema = type({
  pattern: "string > 0",
});

export const ForgotPasswordSchema = type({
  email: "string.email",
});

export const ResetPasswordSchema = type({
  token: "string > 0",
  password: `string >= ${MIN_PASSWORD_LENGTH} & string <= ${MAX_PASSWORD_LENGTH}`,
});

export const AdminUpdateEmailConfigSchema = type({
  "from_email?": "string.email",
  "site_url?": "string.url",
  "template_ids?": {
    "verification?": "number >= 0",
    "welcome?": "number >= 0",
    "invitation?": "number >= 0",
    "password_reset?": "number >= 0",
  },
  "custom_variables?": "Record<string, string>",
});
