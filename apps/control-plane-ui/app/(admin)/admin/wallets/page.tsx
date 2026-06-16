"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api/client";
import { WalletOrgSection } from "@/components/admin/wallet-org-section";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";

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
  is_admin: boolean;
  created_at: string;
}

type TabType = "org" | "master";

export default function AdminWalletsPage() {
  const [activeTab, setActiveTab] = useState<TabType>("org");
  const [search, setSearch] = useState("");

  const { data: organizations, isLoading: orgsLoading } = useSWR(
    "/api/admin/organizations",
    api.get<Organization[]>,
  );

  const {
    data: wallets,
    isLoading: walletsLoading,
    mutate: mutateWallets,
  } = useSWR("/api/admin/wallets", api.get<Wallet[]>);

  const isLoading = orgsLoading || walletsLoading;

  const {
    orgWalletGroups,
    masterWallets,
    filteredOrgWalletGroups,
    filteredMasterWallets,
  } = useMemo(() => {
    if (!organizations || !wallets) {
      return {
        orgWalletGroups: [],
        masterWallets: [],
        filteredOrgWalletGroups: [],
        filteredMasterWallets: [],
      };
    }

    const searchLower = search.toLowerCase();

    const walletsByOrgId = new Map<number | null, Wallet[]>();

    for (const org of organizations) {
      walletsByOrgId.set(org.id, []);
    }
    walletsByOrgId.set(null, []);

    for (const wallet of wallets) {
      const orgId = wallet.organization_id;
      const existing = walletsByOrgId.get(orgId) ?? [];
      existing.push(wallet);
      walletsByOrgId.set(orgId, existing);
    }

    for (const [, walletList] of walletsByOrgId) {
      walletList.sort((a, b) => a.name.localeCompare(b.name));
    }

    const result: { org: Organization; wallets: Wallet[] }[] = [];
    const filteredResult: { org: Organization; wallets: Wallet[] }[] = [];
    const sortedOrgs = [...organizations].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    for (const org of sortedOrgs) {
      const orgWallets = walletsByOrgId.get(org.id) ?? [];
      if (orgWallets.length > 0) {
        result.push({ org, wallets: orgWallets });

        // Apply search filter
        if (search) {
          if (org.name.toLowerCase().includes(searchLower)) {
            // Org matches, include all wallets
            filteredResult.push({ org, wallets: orgWallets });
          } else {
            // Only include matching wallets
            const matchingWallets = orgWallets.filter((w) =>
              w.name.toLowerCase().includes(searchLower),
            );
            if (matchingWallets.length > 0) {
              filteredResult.push({ org, wallets: matchingWallets });
            }
          }
        } else {
          filteredResult.push({ org, wallets: orgWallets });
        }
      }
    }

    const master = walletsByOrgId.get(null) ?? [];
    const filteredMaster = search
      ? master.filter((w) => w.name.toLowerCase().includes(searchLower))
      : master;

    return {
      orgWalletGroups: result,
      masterWallets: master,
      filteredOrgWalletGroups: filteredResult,
      filteredMasterWallets: filteredMaster,
    };
  }, [organizations, wallets, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-12">All Wallets</h1>
          <p className="text-sm text-gray-11">
            View and manage wallets across all organizations
          </p>
        </div>
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-11" />
          <input
            type="text"
            placeholder="Search wallets or orgs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 rounded-md border border-gray-6 bg-gray-3 py-2 pl-9 pr-3 text-sm text-gray-12 placeholder:text-gray-11 focus:border-accent-8 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-6">
        <button
          onClick={() => setActiveTab("org")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "org"
              ? "border-b-2 border-accent-9 text-gray-12"
              : "text-gray-11 hover:text-gray-12"
          }`}
        >
          Organization Wallets
          {orgWalletGroups.length > 0 && (
            <span className="ml-2 rounded-full bg-gray-6 px-2 py-0.5 text-xs">
              {wallets?.filter((w) => w.organization_id !== null).length ?? 0}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("master")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "master"
              ? "border-b-2 border-accent-9 text-gray-12"
              : "text-gray-11 hover:text-gray-12"
          }`}
        >
          Master Wallets
          {masterWallets.length > 0 && (
            <span className="ml-2 rounded-full bg-gray-6 px-2 py-0.5 text-xs">
              {masterWallets.length}
            </span>
          )}
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
        </div>
      ) : activeTab === "org" ? (
        filteredOrgWalletGroups.length > 0 ? (
          <div className="space-y-8">
            {filteredOrgWalletGroups.map(({ org, wallets: orgWallets }) => (
              <WalletOrgSection
                key={org.id}
                org={org}
                wallets={orgWallets}
                onWalletUpdate={() => void mutateWallets()}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-gray-6 bg-gray-2 p-6 text-center">
            <p className="text-sm text-gray-11">
              {search
                ? "No matching wallets or organizations found."
                : "No organizations with wallets found."}
            </p>
          </div>
        )
      ) : filteredMasterWallets.length > 0 ? (
        <div className="space-y-8">
          <WalletOrgSection
            org={{
              id: 0,
              name: "Master Wallets",
              slug: "master",
              is_admin: true,
              created_at: "",
            }}
            wallets={filteredMasterWallets}
            onWalletUpdate={() => void mutateWallets()}
            isMaster
          />
        </div>
      ) : (
        <div className="rounded-lg border border-gray-6 bg-gray-2 p-6 text-center">
          <p className="text-sm text-gray-11">
            {search
              ? "No matching master wallets found."
              : "No master wallets found. Configure master wallets in Settings."}
          </p>
        </div>
      )}
    </div>
  );
}
