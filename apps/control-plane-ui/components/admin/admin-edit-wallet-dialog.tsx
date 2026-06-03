"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Cross2Icon,
  CheckCircledIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";
import {
  extractSolanaAddress,
  isValidSolanaAddress,
  isValidEvmAddress,
  buildAddressOnlyConfig,
} from "@/lib/wallet";

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

interface Tenant {
  id: number;
  name: string;
  wallet_id: number | null;
}

interface AdminEditWalletDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walletId: number;
  walletName: string;
  walletConfig: WalletConfig;
  onSuccess: () => void;
}

function extractAddresses(config: WalletConfig | null): {
  solana: string;
  evm: string;
} {
  if (!config) return { solana: "", evm: "" };
  return {
    solana: extractSolanaAddress(config) ?? "",
    evm: config.evm?.base?.address ?? "",
  };
}

export function AdminEditWalletDialog({
  open,
  onOpenChange,
  walletId,
  walletName,
  walletConfig,
  onSuccess,
}: AdminEditWalletDialogProps) {
  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);

  const initialAddresses = extractAddresses(walletConfig);
  const [name, setName] = useState(walletName);
  const [solanaAddress, setSolanaAddress] = useState(initialAddresses.solana);
  const [evmAddress, setEvmAddress] = useState(initialAddresses.evm);

  // Fetch tenants to check if any use this wallet
  const { data: tenants } = useSWR<Tenant[]>(
    open ? "/api/admin/tenants" : null,
    api.get,
  );

  const tenantsUsingWallet =
    tenants?.filter((t) => t.wallet_id === walletId) ?? [];

  useEffect(() => {
    if (open) {
      const addresses = extractAddresses(walletConfig);
      setName(walletName);
      setSolanaAddress(addresses.solana);
      setEvmAddress(addresses.evm);
    }
  }, [open, walletName, walletConfig]);

  // Check if addresses have changed
  const addressesChanged =
    solanaAddress.trim() !== initialAddresses.solana ||
    evmAddress.trim() !== initialAddresses.evm;

  const solanaValid = !solanaAddress || isValidSolanaAddress(solanaAddress);
  const evmValid = !evmAddress || isValidEvmAddress(evmAddress);
  const hasSolana = solanaAddress.trim() && solanaValid;
  const canSave = name.trim() && hasSolana && evmValid;

  const handleSave = async () => {
    if (!canSave) return;

    setIsSaving(true);
    try {
      const newConfig = buildAddressOnlyConfig({
        solana: solanaAddress.trim() || undefined,
        evm: evmAddress.trim() || undefined,
      });

      await api.put(`/api/wallets/${walletId}`, {
        name: name.trim(),
        wallet_config: newConfig,
      });

      toast({
        title: "Wallet updated",
        description: "Wallet has been updated successfully.",
        variant: "success",
      });
      onSuccess();
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to update wallet",
        variant: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-1 p-6 shadow-xl max-h-[85vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-lg font-semibold text-gray-12">
              Edit Wallet
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12">
              <Cross2Icon className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-sm text-gray-11 mb-6">
            Update the wallet name and addresses.
          </Dialog.Description>

          <div className="space-y-5">
            <div>
              <label className="mb-1.5 block text-sm text-gray-11">
                Wallet Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Main Wallet"
                className="w-full rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
              />
            </div>

            <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
              <label className="block text-sm font-medium text-gray-12 mb-2">
                Solana Address <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={solanaAddress}
                onChange={(e) => setSolanaAddress(e.target.value)}
                placeholder="e.g., 5ZZguz4NsSRFxGkHfYnS..."
                className={`w-full rounded-md border bg-gray-3 px-3 py-2 font-mono text-xs text-gray-12 placeholder:text-gray-8 focus:outline-none ${
                  solanaAddress && !solanaValid
                    ? "border-red-500 focus:border-red-500"
                    : "border-gray-6 focus:border-accent-8"
                }`}
              />
              {solanaAddress && !solanaValid && (
                <div className="flex items-center gap-2 text-xs mt-2">
                  <CrossCircledIcon className="h-3.5 w-3.5 text-red-400" />
                  <span className="text-red-400">Invalid Solana address</span>
                </div>
              )}
              {solanaAddress && solanaValid && (
                <div className="flex items-center gap-2 text-xs mt-2">
                  <CheckCircledIcon className="h-3.5 w-3.5 text-green-400" />
                  <span className="text-green-400">Valid address</span>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
              <div className="mb-2">
                <label className="block text-sm font-medium text-gray-12">
                  EVM Address
                </label>
                <span className="text-xs text-gray-11">
                  Used for Base, Polygon, and Monad
                </span>
              </div>
              <input
                type="text"
                value={evmAddress}
                onChange={(e) => setEvmAddress(e.target.value)}
                placeholder="e.g., 0x1234..."
                className={`w-full rounded-md border bg-gray-3 px-3 py-2 font-mono text-xs text-gray-12 placeholder:text-gray-8 focus:outline-none ${
                  evmAddress && !evmValid
                    ? "border-red-500 focus:border-red-500"
                    : "border-gray-6 focus:border-accent-8"
                }`}
              />
              {evmAddress && !evmValid && (
                <div className="flex items-center gap-2 text-xs mt-2">
                  <CrossCircledIcon className="h-3.5 w-3.5 text-red-400" />
                  <span className="text-red-400">Invalid EVM address</span>
                </div>
              )}
              {evmAddress && evmValid && (
                <div className="flex items-center gap-2 text-xs mt-2">
                  <CheckCircledIcon className="h-3.5 w-3.5 text-green-400" />
                  <span className="text-green-400">Valid address</span>
                </div>
              )}
            </div>

            {!hasSolana && (
              <p className="text-xs text-yellow-400">
                Solana address is required for wallet funding verification.
              </p>
            )}

            {addressesChanged && tenantsUsingWallet.length > 0 && (
              <div className="rounded-lg border border-red-500/50 bg-red-900/20 p-4">
                <div className="flex items-start gap-3">
                  <ExclamationTriangleIcon className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-red-400 mb-1">
                      Warning: This will temporarily disable API endpoints
                    </p>
                    <p className="text-gray-11 mb-2">
                      Changing addresses resets the wallet to
                      &quot;pending&quot; status. The following tenant(s) will
                      stop working until the new address is funded:
                    </p>
                    <ul className="list-disc list-inside text-gray-12 space-y-0.5">
                      {tenantsUsingWallet.map((t) => (
                        <li key={t.id}>{t.name}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close asChild>
              <button className="rounded-md border border-gray-6 px-4 py-2 text-sm text-gray-11 hover:bg-gray-3">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={() => void handleSave()}
              disabled={!canSave || isSaving}
              className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
