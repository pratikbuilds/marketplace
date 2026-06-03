"use client";

import { AdminWalletsTable } from "./admin-wallets-table";

interface WalletConfig {
  solana?: {
    "mainnet-beta"?: {
      address: string;
    };
    devnet?: {
      address: string;
    };
  };
  evm?: {
    base?: { address: string };
    polygon?: { address: string };
    monad?: { address: string };
  };
}

interface Wallet {
  id: number;
  organization_id: number | null;
  name: string;
  wallet_config: WalletConfig;
  funding_status: string;
  created_at: string;
  organization_name: string | null;
}

interface Organization {
  id: number;
  name: string;
  slug: string;
  is_admin?: boolean;
  created_at?: string;
}

interface WalletOrgSectionProps {
  org: Organization;
  wallets: Wallet[];
  onWalletUpdate?: () => void;
  isMaster?: boolean;
}

export function WalletOrgSection({
  org,
  wallets,
  onWalletUpdate,
  isMaster = false,
}: WalletOrgSectionProps) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-lg font-semibold text-gray-12">{org.name}</h2>
        <span className="rounded-full bg-gray-6 px-2.5 py-0.5 text-xs font-medium text-gray-11">
          {wallets.length} wallet{wallets.length !== 1 ? "s" : ""}
        </span>
      </div>
      {wallets.length > 0 ? (
        <AdminWalletsTable
          wallets={wallets}
          onWalletUpdate={onWalletUpdate}
          isMaster={isMaster}
        />
      ) : (
        <div className="rounded-lg border border-gray-6 bg-gray-2 px-4 py-3">
          <p className="text-sm text-gray-11">
            No wallets in this organization
          </p>
        </div>
      )}
    </div>
  );
}
