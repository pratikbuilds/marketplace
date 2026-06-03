"use client";

import { useState } from "react";
import useSWR from "swr";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import {
  CopyIcon,
  CheckIcon,
  TrashIcon,
  Pencil1Icon,
} from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";
import { InlineNameEdit } from "@/components/shared/inline-name-edit";
import { AdminEditWalletDialog } from "./admin-edit-wallet-dialog";
import { extractSolanaAddress } from "@/lib/wallet";

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

interface ChainBalances {
  native: string;
  usdc: string;
}

interface WalletBalances {
  solana: ChainBalances;
  base: ChainBalances;
  polygon: ChainBalances;
  monad: ChainBalances;
}

interface AdminWalletsTableProps {
  wallets: Wallet[];
  onWalletUpdate?: () => void;
  isMaster?: boolean;
}

function extractAddresses(config: WalletConfig | null): {
  solana: string | null;
  evm: string | null;
} {
  if (!config) return { solana: null, evm: null };
  return {
    solana: extractSolanaAddress(config),
    evm: config.evm?.base?.address ?? null,
  };
}

function truncateAddress(address: string, chars = 6): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

const CHAINS = [
  { id: "solana", name: "Solana", native: "SOL" },
  { id: "base", name: "Base", native: "ETH" },
  { id: "polygon", name: "Polygon", native: "MATIC" },
  { id: "monad", name: "Monad", native: "MON" },
] as const;

function WalletBalanceCell({
  walletId,
  walletConfig,
}: {
  walletId: number;
  walletConfig: WalletConfig;
}) {
  const { data: balances, isLoading } = useSWR<WalletBalances>(
    `/api/wallets/${walletId}/balances`,
    api.get,
    { refreshInterval: 60000 },
  );

  const addresses = extractAddresses(walletConfig);
  const availableChains = CHAINS.filter((chain) => {
    if (chain.id === "solana") return addresses.solana !== null;
    return addresses.evm !== null;
  });

  if (isLoading) {
    return (
      <div className="flex gap-2">
        <span className="inline-block h-4 w-16 animate-pulse rounded bg-gray-5" />
      </div>
    );
  }

  if (!balances || availableChains.length === 0) {
    return <span className="text-gray-11">-</span>;
  }

  return (
    <div className="text-xs space-y-1">
      {availableChains.map((chain) => {
        const chainBalances = balances[chain.id as keyof WalletBalances];
        return (
          <div key={chain.id} className="flex items-center gap-3">
            <span className="text-gray-11 w-10">{chain.native}</span>
            <div className="font-mono text-gray-12">
              <div>{chainBalances?.native ?? "-"}</div>
              <div>{chainBalances?.usdc ? `$${chainBalances.usdc}` : "-"}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface Tenant {
  id: number;
  name: string;
  wallet_id: number | null;
}

function WalletRow({
  wallet,
  onWalletUpdate,
}: {
  wallet: Wallet;
  onWalletUpdate?: () => void;
}) {
  const { toast } = useToast();
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Fetch tenants to check if any use this wallet (for delete warning)
  const { data: tenants } = useSWR<Tenant[]>(
    showDeleteDialog ? "/api/admin/tenants" : null,
    api.get,
  );
  const tenantsUsingWallet =
    tenants?.filter((t) => t.wallet_id === wallet.id) ?? [];

  const addresses = extractAddresses(wallet.wallet_config);

  const copyToClipboard = async (address: string) => {
    await navigator.clipboard.writeText(address);
    setCopiedAddress(address);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await api.delete(`/api/wallets/${wallet.id}`);
      toast({
        title: "Wallet deleted",
        description: "The wallet has been deleted.",
        variant: "success",
      });
      onWalletUpdate?.();
      setShowDeleteDialog(false);
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to delete wallet",
        variant: "error",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <tr className="group hover:bg-gray-3">
      <td className="px-4 py-3">
        <InlineNameEdit
          name={wallet.name}
          onUpdate={() => onWalletUpdate?.()}
          apiEndpoint={`/api/wallets/${wallet.id}`}
          label="Wallet Name"
        />
      </td>
      <td className="px-4 py-3">
        {addresses.solana ? (
          <div className="flex items-center gap-1.5">
            <code className="rounded bg-gray-3 px-1.5 py-0.5 font-mono text-xs text-gray-12">
              {truncateAddress(addresses.solana)}
            </code>
            <button
              onClick={() => void copyToClipboard(addresses.solana ?? "")}
              className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
            >
              {copiedAddress === addresses.solana ? (
                <CheckIcon className="h-3 w-3 text-green-400" />
              ) : (
                <CopyIcon className="h-3 w-3" />
              )}
            </button>
          </div>
        ) : (
          <span className="text-xs text-gray-11">-</span>
        )}
      </td>
      <td className="px-4 py-3">
        {addresses.evm ? (
          <div className="flex items-center gap-1.5">
            <code className="rounded bg-gray-3 px-1.5 py-0.5 font-mono text-xs text-gray-12">
              {truncateAddress(addresses.evm)}
            </code>
            <button
              onClick={() => void copyToClipboard(addresses.evm ?? "")}
              className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
            >
              {copiedAddress === addresses.evm ? (
                <CheckIcon className="h-3 w-3 text-green-400" />
              ) : (
                <CopyIcon className="h-3 w-3" />
              )}
            </button>
          </div>
        ) : (
          <span className="text-xs text-gray-11">-</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            wallet.funding_status === "funded"
              ? "bg-green-900/30 text-green-400"
              : "bg-yellow-900/30 text-yellow-400"
          }`}
        >
          {wallet.funding_status === "funded" ? "Funded" : "Pending"}
        </span>
      </td>
      <td className="px-4 py-3">
        <WalletBalanceCell
          walletId={wallet.id}
          walletConfig={wallet.wallet_config}
        />
      </td>
      <td className="px-4 py-3">
        <span className="text-xs text-gray-11">
          {new Date(wallet.created_at).toLocaleDateString()}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowEditDialog(true)}
            className="rounded p-1.5 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
            title="Edit wallet"
          >
            <Pencil1Icon className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowDeleteDialog(true)}
            className="rounded p-1.5 text-gray-11 hover:bg-red-900/30 hover:text-red-400"
            title="Delete wallet"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>

        <AdminEditWalletDialog
          open={showEditDialog}
          onOpenChange={setShowEditDialog}
          walletId={wallet.id}
          walletName={wallet.name}
          walletConfig={wallet.wallet_config}
          onSuccess={() => onWalletUpdate?.()}
        />

        <AlertDialog.Root
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
        >
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
            <AlertDialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-lg">
              <AlertDialog.Title className="text-lg font-semibold text-gray-12">
                Delete Wallet
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-3 text-sm text-gray-11">
                Are you sure you want to delete{" "}
                <span className="font-medium text-gray-12">{wallet.name}</span>?
                This action cannot be undone.
                {tenantsUsingWallet.length > 0 && (
                  <>
                    <br />
                    <br />
                    <span className="text-yellow-400">
                      This wallet is used by {tenantsUsingWallet.length} tenant
                      {tenantsUsingWallet.length > 1 ? "s" : ""} and cannot be
                      deleted.
                    </span>
                  </>
                )}
              </AlertDialog.Description>
              <div className="mt-6 flex justify-end gap-3">
                <AlertDialog.Cancel asChild>
                  <button className="rounded-md px-3 py-2 text-sm font-medium text-gray-11 hover:bg-gray-4 hover:text-gray-12">
                    Cancel
                  </button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <button
                    onClick={() => void handleDelete()}
                    disabled={isDeleting || tenantsUsingWallet.length > 0}
                    className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {isDeleting ? "Deleting..." : "Delete"}
                  </button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </td>
    </tr>
  );
}

export function AdminWalletsTable({
  wallets,
  onWalletUpdate,
}: AdminWalletsTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-6 bg-gray-2">
      <table className="w-full min-w-[900px]">
        <thead>
          <tr className="border-b border-gray-6 bg-gray-3">
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-11">
              Name
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-11">
              Solana
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-11">
              EVM
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-11">
              Status
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-11">
              Balances
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-11">
              Created
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-11">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-6">
          {wallets.map((wallet) => (
            <WalletRow
              key={wallet.id}
              wallet={wallet}
              onWalletUpdate={onWalletUpdate}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
