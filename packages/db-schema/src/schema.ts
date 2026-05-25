import type { ColumnType } from "kysely";

type DateColumn = ColumnType<Date | string, Date | string, Date | string>;
type OptionalDateColumn = ColumnType<
  Date | string,
  Date | string | undefined,
  Date | string
>;
type NullableDateColumn = ColumnType<
  Date | string | null,
  Date | string | null,
  Date | string | null
>;
type AutoDateColumn = ColumnType<Date | string, never, never>;

export interface Database {
  tenants: TenantsTable;
  nodes: NodesTable;
  endpoints: EndpointsTable;
  transactions: TransactionsTable;
  organizations: OrganizationsTable;
  users: UsersTable;
  user_organizations: UserOrganizationsTable;
  organization_invitations: OrganizationInvitationsTable;
  tenant_nodes: TenantNodesTable;
  admin_settings: AdminSettingsTable;
  wallets: WalletsTable;
  waitlist: WaitlistTable;
  password_reset_tokens: PasswordResetTokensTable;
  discovery_telemetry: DiscoveryTelemetryTable;
  token_prices: TokenPricesTable;
  supported_tokens: SupportedTokensTable;
}

export interface OrganizationsTable {
  id: ColumnType<number, never, never>;
  name: string;
  slug: string;
  is_admin: ColumnType<boolean, boolean | undefined, boolean>;
  onboarding_completed: ColumnType<boolean, boolean | undefined, boolean>;
  onboarding_completed_at: NullableDateColumn;
  created_at: AutoDateColumn;
}

export interface UsersTable {
  id: ColumnType<number, never, never>;
  email: string;
  password_hash: string;
  is_admin: ColumnType<boolean, boolean | undefined, boolean>;
  email_verified: ColumnType<boolean, boolean | undefined, boolean>;
  verification_token: string | null;
  verification_expires: NullableDateColumn;
  created_at: AutoDateColumn;
}

export interface UserOrganizationsTable {
  id: ColumnType<number, never, never>;
  user_id: number;
  organization_id: number;
  role: string;
  joined_at: ColumnType<string, never, never>;
}

export interface OrganizationInvitationsTable {
  id: ColumnType<number, never, never>;
  organization_id: number;
  email: string;
  token: string;
  role: ColumnType<string, string | undefined, string>;
  invited_by: number | null;
  expires_at: DateColumn;
  accepted_at: NullableDateColumn;
  created_at: AutoDateColumn;
}

export interface TenantsTable {
  id: ColumnType<number, never, never>;
  name: string;
  backend_url: string;
  organization_id: number | null;
  wallet_id: number | null;
  status: ColumnType<string, string | undefined, string>;
  default_price: number;
  default_scheme: string;
  upstream_auth_header: string | null;
  upstream_auth_value: string | null;
  openapi_spec: ColumnType<unknown, string | undefined, string> | null;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  org_slug: string | null;
  tags: ColumnType<string[], string[] | undefined, string[] | undefined>;
  created_at: AutoDateColumn;
}

export interface NodesTable {
  id: ColumnType<number, never, never>;
  name: string;
  internal_ip: string;
  public_ip: string | null;
  status: string;
  wireguard_public_key: string | null;
  wireguard_address: string | null;
  created_at: AutoDateColumn;
}

export interface TenantNodesTable {
  id: ColumnType<number, never, never>;
  tenant_id: number;
  node_id: number;
  is_primary: ColumnType<boolean, boolean | undefined, boolean>;
  health_check_id: string | null;
  cert_status: string | null;
  created_at: AutoDateColumn;
}

export interface EndpointsTable {
  id: ColumnType<number, never, never>;
  tenant_id: number;
  path: string | null;
  path_pattern: string;
  http_method: ColumnType<string, string | undefined, string>;
  price: number | null;
  scheme: string | null;
  description: string | null;
  priority: ColumnType<number, number | undefined, number>;
  openapi_source_paths: ColumnType<
    string[] | null,
    string[] | undefined,
    string[] | undefined
  >;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  tags: ColumnType<string[], string[] | undefined, string[] | undefined>;
  created_at: AutoDateColumn;
  deleted_at: NullableDateColumn;
}

export interface TransactionsTable {
  id: ColumnType<number, never, never>;
  endpoint_id: number | null;
  tenant_id: number;
  organization_id: number | null;
  amount: number;
  ngx_request_id: string;
  tx_hash: string | null;
  network: string | null;
  token_symbol: string | null;
  mint_address: string | null;
  request_path: string;
  client_ip: string | null;
  request_method: string | null;
  metadata: ColumnType<unknown, string | undefined, string> | null;
  created_at: AutoDateColumn;
}

export interface AdminSettingsTable {
  id: ColumnType<number, never, never>;
  wallet_config: ColumnType<unknown, string | undefined, string> | null;
  minimum_balance_sol: ColumnType<number, number | undefined, number>;
  minimum_balance_usdc: ColumnType<number, number | undefined, number>;
  email_config: ColumnType<unknown, string | undefined, string> | null;
  created_at: AutoDateColumn;
  updated_at: OptionalDateColumn;
}

export interface WalletsTable {
  id: ColumnType<number, never, never>;
  organization_id: number | null;
  name: string;
  wallet_config: ColumnType<unknown, string, string>;
  funding_status: ColumnType<string, string | undefined, string>;
  cached_balances: ColumnType<unknown, string | undefined, string> | null;
  balances_cached_at: NullableDateColumn;
  created_at: AutoDateColumn;
}

export interface WaitlistTable {
  id: ColumnType<number, never, never>;
  email: string;
  whitelisted: ColumnType<boolean, boolean | undefined, boolean>;
  signed_up: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: AutoDateColumn;
}

export interface PasswordResetTokensTable {
  id: ColumnType<number, never, never>;
  user_id: number;
  token: string;
  expires_at: DateColumn;
  used_at: NullableDateColumn;
  created_at: AutoDateColumn;
}

export interface TokenPricesTable {
  id: ColumnType<number, never, never>;
  tenant_id: number;
  endpoint_id: number | null;
  token_symbol: string;
  mint_address: string;
  network: string;
  amount: ColumnType<string, number | string, number | string>;
  decimals: ColumnType<number, number | undefined, number>;
  payout_splits: ColumnType<unknown, string | null | undefined, string | null>;
  created_at: AutoDateColumn;
  updated_at: OptionalDateColumn;
}

export interface SupportedTokensTable {
  id: ColumnType<number, never, never>;
  symbol: string;
  mint_address: string;
  network: string;
  is_usd_pegged: ColumnType<boolean, boolean | undefined, boolean>;
  decimals: ColumnType<number, number | undefined, number>;
  created_at: AutoDateColumn;
}

export interface SupportedToken {
  symbol: string;
  mint: string;
  network: string;
  isUsdPegged: boolean;
  decimals: number;
}

export interface DiscoveryTelemetryTable {
  id: ColumnType<number, never, never>;
  event_type: string;
  event_key: string | null;
  proxy_id: number | null;
  endpoint_id: number | null;
  bucket: DateColumn;
  count: ColumnType<number, number | undefined, number>;
  created_at: AutoDateColumn;
  updated_at: OptionalDateColumn;
}
