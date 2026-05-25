import { type } from "arktype";

export const MIN_PRICE = 1; // $0.000001 in micro-units
export const MAX_PRICE = 100_000_000; // $100 in micro-units
export const MIN_PRICE_USD = MIN_PRICE / 1_000_000; // $0.000001
export const MAX_PRICE_USD = MAX_PRICE / 1_000_000; // $100

export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 50;

// Add new schemes here - this is the single source of truth
export const SCHEMES = ["exact", "flex"] as const;
export type Scheme = (typeof SCHEMES)[number];
export const DEFAULT_SCHEME: Scheme = "flex";

export const SchemeSchema = type("'exact' | 'flex'");

export function isScheme(value: string): value is Scheme {
  return value === "exact" || value === "flex";
}

export const SCHEME_OPTIONS = SCHEMES.map((s) => ({
  value: s,
  label: s,
  disabled: false,
}));

export const TenantSchema = type({
  id: "number",
  name: "string",
  backend_url: "string",
  "wallet_id?": "number | null",
  default_price: "number",
  default_scheme: "string",
  "upstream_auth_header?": "string | null",
  "upstream_auth_value?": "string | null",
  is_active: "boolean",
  created_at: "string",
  "tags?": "string[]",
});

export type Tenant = typeof TenantSchema.infer;

export const NodeSchema = type({
  id: "number",
  name: "string",
  internal_ip: "string",
  "public_ip?": "string | null",
  status: "string",
  "wireguard_public_key?": "string | null",
  "wireguard_address?": "string | null",
  created_at: "string",
});

export type Node = typeof NodeSchema.infer;

export const EndpointSchema = type({
  id: "number",
  tenant_id: "number",
  path_pattern: "string",
  "price?": "number | null",
  "scheme?": "string | null",
  "description?": "string | null",
  priority: "number",
  is_active: "boolean",
  created_at: "string",
  "deleted_at?": "string | null",
  "tags?": "string[]",
});

export type Endpoint = typeof EndpointSchema.infer;

export const TransactionSchema = type({
  id: "number",
  "endpoint_id?": "number | null",
  tenant_id: "number",
  amount: "number",
  tx_hash: "string",
  network: "string",
  "token_symbol?": "string | null",
  "mint_address?": "string | null",
  request_path: "string",
  created_at: "string",
});

export type Transaction = typeof TransactionSchema.infer;

export interface TokenPrice {
  id: number;
  tenant_id: number;
  endpoint_id: number | null;
  token_symbol: string;
  mint_address: string;
  network: string;
  amount: string;
  decimals: number;
}

export interface SupportedToken {
  symbol: string;
  mint: string;
  network: string;
  isUsdPegged: boolean;
  decimals: number;
}
