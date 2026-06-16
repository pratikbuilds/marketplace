"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/context";
import useSWR from "swr";
import * as Dialog from "@radix-ui/react-dialog";
import {
  CopyIcon,
  CheckIcon,
  ReloadIcon,
  CheckCircledIcon,
  CrossCircledIcon,
  PlusIcon,
  TrashIcon,
  Cross2Icon,
} from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import {
  buildAddressOnlyConfig,
  extractSolanaAddress,
  isValidSolanaAddress,
  isValidEvmAddress,
} from "@/lib/wallet";
import { useToast } from "@/components/ui/toast";
import {
  refreshOnboardingStatus,
  useOnboarding,
} from "@/lib/hooks/use-onboarding";
import { QRCodeSVG } from "qrcode.react";

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
  name: string;
  organization_id: number;
  wallet_config: WalletConfig;
  funding_status: string;
  created_at: string;
}

interface ChainBalances {
  native: string;
  usdc: string;
  tokens?: { symbol: string; amount: string; usdEquivalent?: number }[];
}

interface WalletBalances {
  solana: ChainBalances;
  base: ChainBalances;
  polygon: ChainBalances;
  monad: ChainBalances;
}

interface WalletBalancesResponse extends WalletBalances {
  isFunded?: boolean;
}

const CHAINS = [
  { id: "solana", name: "Solana", native: "SOL", color: "purple" },
  { id: "base", name: "Base", native: "ETH", color: "blue" },
  { id: "polygon", name: "Polygon", native: "MATIC", color: "violet" },
  { id: "monad", name: "Monad", native: "MON", color: "green" },
] as const;

function CreateWalletModal({
  open,
  onOpenChange,
  onSave,
  isSaving,
  organizationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: { name: string; solana?: string; evm?: string }) => void;
  isSaving: boolean;
  organizationId: number;
}) {
  const [name, setName] = useState("");
  const [solanaAddress, setSolanaAddress] = useState("");
  const [evmAddress, setEvmAddress] = useState("");
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [isCheckingName, setIsCheckingName] = useState(false);
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setSolanaAddress("");
      setEvmAddress("");
      setNameAvailable(null);
      setIsCheckingName(false);
    }
  }, [open]);

  useEffect(() => {
    if (!name.trim()) {
      setNameAvailable(null);
      return;
    }

    setIsCheckingName(true);
    setNameAvailable(null);

    if (checkTimeoutRef.current) {
      clearTimeout(checkTimeoutRef.current);
    }

    checkTimeoutRef.current = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.get<{ available: boolean }>(
            `/api/wallets/organization/${organizationId}/check-name?name=${encodeURIComponent(name.trim())}`,
          );
          setNameAvailable(result.available);
        } catch {
          setNameAvailable(null);
        } finally {
          setIsCheckingName(false);
        }
      })();
    }, 500);

    return () => {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current);
      }
    };
  }, [name, organizationId]);

  const solanaValid =
    solanaAddress.trim() && isValidSolanaAddress(solanaAddress);
  const evmValid = !evmAddress || isValidEvmAddress(evmAddress);
  const canSave =
    name.trim() && nameAvailable === true && solanaValid && evmValid;

  const handleSave = () => {
    onSave({
      name: name.trim(),
      solana: solanaAddress.trim(),
      evm: evmAddress.trim() || undefined,
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-1 p-6 shadow-xl max-h-[85vh] overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold text-gray-12">
            Create Wallet
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-11">
            Enter a name and your public wallet addresses where you want to
            receive payments.
          </Dialog.Description>

          <div className="mt-6 space-y-5">
            <div>
              <label className="mb-1.5 block text-sm text-gray-11">
                Wallet Name <span className="text-red-400">*</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Main Wallet"
                  className="flex-1 rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                />
                {name.trim() && (
                  <>
                    {isCheckingName ? (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-6 border-t-gray-11" />
                    ) : nameAvailable === true ? (
                      <CheckCircledIcon className="h-4 w-4 text-green-500" />
                    ) : nameAvailable === false ? (
                      <CrossCircledIcon className="h-4 w-4 text-red-500" />
                    ) : null}
                  </>
                )}
              </div>
              {name.trim() && nameAvailable === false && !isCheckingName && (
                <p className="mt-1 text-xs text-red-400">
                  This name is already taken
                </p>
              )}
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
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close asChild>
              <button className="rounded-md border border-gray-6 px-4 py-2 text-sm text-gray-11 hover:bg-gray-3">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={handleSave}
              disabled={!canSave || isSaving}
              className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? "Creating..." : "Create Wallet"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EditWalletModal({
  open,
  onOpenChange,
  onSave,
  isSaving,
  initialName,
  initialSolana = "",
  initialEvm = "",
  walletId,
  organizationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: { name: string; solana?: string; evm?: string }) => void;
  isSaving: boolean;
  initialName: string;
  initialSolana?: string;
  initialEvm?: string;
  walletId: number;
  organizationId: number;
}) {
  const [name, setName] = useState(initialName);
  const [solanaAddress, setSolanaAddress] = useState(initialSolana);
  const [evmAddress, setEvmAddress] = useState(initialEvm);
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [isCheckingName, setIsCheckingName] = useState(false);
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setSolanaAddress(initialSolana);
      setEvmAddress(initialEvm);
      setNameAvailable(true);
      setIsCheckingName(false);
    }
  }, [open, initialName, initialSolana, initialEvm]);

  useEffect(() => {
    if (!name.trim()) {
      setNameAvailable(null);
      return;
    }

    // If name unchanged, it's valid
    if (name.trim() === initialName) {
      setNameAvailable(true);
      setIsCheckingName(false);
      return;
    }

    setIsCheckingName(true);
    setNameAvailable(null);

    if (checkTimeoutRef.current) {
      clearTimeout(checkTimeoutRef.current);
    }

    checkTimeoutRef.current = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.get<{ available: boolean }>(
            `/api/wallets/organization/${organizationId}/check-name?name=${encodeURIComponent(name.trim())}&excludeId=${walletId}`,
          );
          setNameAvailable(result.available);
        } catch {
          setNameAvailable(null);
        } finally {
          setIsCheckingName(false);
        }
      })();
    }, 500);

    return () => {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current);
      }
    };
  }, [name, initialName, organizationId, walletId]);

  const solanaValid =
    solanaAddress.trim() && isValidSolanaAddress(solanaAddress);
  const evmValid = !evmAddress || isValidEvmAddress(evmAddress);
  const canSave =
    name.trim() && nameAvailable === true && solanaValid && evmValid;

  const handleSave = () => {
    onSave({
      name: name.trim(),
      solana: solanaAddress.trim(),
      evm: evmAddress.trim() || undefined,
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-1 p-6 shadow-xl max-h-[85vh] overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold text-gray-12">
            Edit Wallet
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-11">
            Update the wallet name and addresses.
          </Dialog.Description>

          <div className="mt-6 space-y-5">
            <div>
              <label className="mb-1.5 block text-sm text-gray-11">
                Wallet Name <span className="text-red-400">*</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Main Wallet"
                  className="flex-1 rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                />
                {name.trim() && (
                  <>
                    {isCheckingName ? (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-6 border-t-gray-11" />
                    ) : nameAvailable === true ? (
                      <CheckCircledIcon className="h-4 w-4 text-green-500" />
                    ) : nameAvailable === false ? (
                      <CrossCircledIcon className="h-4 w-4 text-red-500" />
                    ) : null}
                  </>
                )}
              </div>
              {name.trim() && nameAvailable === false && !isCheckingName && (
                <p className="mt-1 text-xs text-red-400">
                  This name is already taken
                </p>
              )}
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
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close asChild>
              <button className="rounded-md border border-gray-6 px-4 py-2 text-sm text-gray-11 hover:bg-gray-3">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={handleSave}
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

function WalletCard({
  wallet,
  isOwner,
  onEdit,
  onDelete,
  organizationId,
}: {
  wallet: Wallet;
  isOwner: boolean;
  onEdit: (
    wallet: Wallet,
    data: { name: string; solana?: string; evm?: string },
  ) => Promise<void>;
  onDelete: (wallet: Wallet) => void;
  organizationId: number;
}) {
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const {
    data: balances,
    isLoading: balancesLoading,
    mutate: mutateBalances,
  } = useSWR<WalletBalancesResponse>(
    `/api/wallets/${wallet.id}/balances`,
    api.get,
    {
      refreshInterval: 60000,
    },
  );

  const addresses = extractAddresses(wallet.wallet_config);

  const copyToClipboard = async (address: string) => {
    await navigator.clipboard.writeText(address);
    setCopiedAddress(address);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await mutateBalances();
    } finally {
      setIsRefreshing(false);
    }
  };

  const getBalancesForChain = (chainId: string): ChainBalances | null => {
    if (!balances) return null;
    return balances[chainId as keyof WalletBalances];
  };

  const availableChains = CHAINS.filter((chain) => {
    if (chain.id === "solana") return addresses.solana !== null;
    return addresses.evm !== null;
  });

  const handleSave = async (data: {
    name: string;
    solana?: string;
    evm?: string;
  }) => {
    setIsSaving(true);
    await onEdit(wallet, data);
    await mutateBalances();
    setIsSaving(false);
    setShowEditModal(false);
  };

  return (
    <div className="rounded-lg border border-gray-6 bg-gray-2 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-12">{wallet.name}</h3>
          <p className="text-xs text-gray-11">
            Created {new Date(wallet.created_at).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isOwner && (
            <button
              onClick={() => setShowEditModal(true)}
              className="rounded-md border border-gray-6 px-3 py-1.5 text-xs text-gray-11 hover:bg-gray-3"
            >
              Edit
            </button>
          )}
          <button
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 rounded-md border border-gray-6 px-3 py-1.5 text-xs text-gray-11 hover:bg-gray-3 disabled:opacity-50"
          >
            <ReloadIcon
              className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
          {isOwner && (
            <button
              onClick={() => onDelete(wallet)}
              className="rounded p-1.5 text-gray-11 hover:bg-red-900/30 hover:text-red-400"
              title="Delete wallet"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {(() => {
          const solana = addresses.solana;
          if (!solana) return null;
          return (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-11 w-16">Solana:</span>
              <code
                onClick={() => void copyToClipboard(solana)}
                className="flex-1 rounded border border-gray-6 bg-gray-3 px-2 py-1 font-mono text-xs text-gray-12 truncate cursor-pointer hover:bg-gray-4"
                title="Click to copy"
              >
                {solana}
              </code>
              <button
                onClick={() => void copyToClipboard(solana)}
                className="rounded p-1 text-gray-11 hover:bg-gray-3 hover:text-gray-12"
              >
                {copiedAddress === solana ? (
                  <CheckIcon className="h-3.5 w-3.5 text-green-400" />
                ) : (
                  <CopyIcon className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          );
        })()}
        {(() => {
          const evm = addresses.evm;
          if (!evm) return null;
          return (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-11 w-16">EVM:</span>
              <code
                onClick={() => void copyToClipboard(evm)}
                className="flex-1 rounded border border-gray-6 bg-gray-3 px-2 py-1 font-mono text-xs text-gray-12 truncate cursor-pointer hover:bg-gray-4"
                title="Click to copy"
              >
                {evm}
              </code>
              <button
                onClick={() => void copyToClipboard(evm)}
                className="rounded p-1 text-gray-11 hover:bg-gray-3 hover:text-gray-12"
              >
                {copiedAddress === evm ? (
                  <CheckIcon className="h-3.5 w-3.5 text-green-400" />
                ) : (
                  <CopyIcon className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          );
        })()}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {availableChains.map((chain) => {
          const chainBalances = getBalancesForChain(chain.id);
          return (
            <div
              key={chain.id}
              className="rounded border border-gray-6 bg-gray-3 p-3"
            >
              <p className="text-xs font-medium text-gray-12 mb-2">
                {chain.name}
              </p>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-11">{chain.native}</span>
                  <span className="font-mono text-xs text-gray-12">
                    {balancesLoading ? (
                      <span className="inline-block h-3 w-10 animate-pulse rounded bg-gray-5" />
                    ) : (
                      (chainBalances?.native ?? "-")
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-11">USDC</span>
                  <span className="font-mono text-xs text-gray-12">
                    {balancesLoading ? (
                      <span className="inline-block h-3 w-10 animate-pulse rounded bg-gray-5" />
                    ) : chainBalances?.usdc ? (
                      `$${chainBalances.usdc}`
                    ) : (
                      "-"
                    )}
                  </span>
                </div>
                {chainBalances?.tokens?.map((t) => (
                  <div
                    key={t.symbol}
                    className="flex items-center justify-between"
                  >
                    <span className="text-xs text-gray-11">{t.symbol}</span>
                    <div className="text-right">
                      <span className="font-mono text-xs text-gray-12">
                        {t.amount}
                      </span>
                      {t.usdEquivalent !== undefined && (
                        <span className="ml-1 text-[10px] text-gray-9">
                          (~${t.usdEquivalent.toFixed(2)})
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <EditWalletModal
        open={showEditModal}
        onOpenChange={setShowEditModal}
        onSave={(data) => void handleSave(data)}
        isSaving={isSaving}
        initialName={wallet.name}
        initialSolana={addresses.solana ?? ""}
        initialEvm={addresses.evm ?? ""}
        walletId={wallet.id}
        organizationId={organizationId}
      />
    </div>
  );
}

export default function WalletsPage() {
  const router = useRouter();
  const { currentOrg, user } = useAuth();
  const { toast } = useToast();
  const { status: onboardingStatus } = useOnboarding();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [walletToDelete, setWalletToDelete] = useState<Wallet | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showInUseDialog, setShowInUseDialog] = useState(false);
  const [tenantsUsingWallet, setTenantsUsingWallet] = useState<string[]>([]);
  const [copiedFundingAddress, setCopiedFundingAddress] = useState<
    string | null
  >(null);

  const currentRole = user?.organizations.find(
    (o) => o.id === currentOrg?.id,
  )?.role;
  const isOwner = currentRole === "owner" || user?.is_admin;

  const [dismissedFundingModal, _setDismissedFundingModal] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem("funding-modal-dismissed") === "true";
  });
  const setDismissedFundingModal = (value: boolean) => {
    _setDismissedFundingModal(value);
    if (typeof window !== "undefined") {
      if (value) {
        sessionStorage.setItem("funding-modal-dismissed", "true");
      } else {
        sessionStorage.removeItem("funding-modal-dismissed");
      }
    }
  };
  const [isContinuing, setIsContinuing] = useState(false);
  const [showFundingEditModal, setShowFundingEditModal] = useState(false);
  const [isSavingFundingEdit, setIsSavingFundingEdit] = useState(false);
  const [forceShowFundingModal, setForceShowFundingModal] = useState(false);
  const [fundingFlowActive, setFundingFlowActive] = useState(false);

  useEffect(() => {
    if (
      !onboardingStatus?.onboarding_completed &&
      onboardingStatus?.steps.wallet &&
      !onboardingStatus?.steps.funded &&
      !fundingFlowActive
    ) {
      setFundingFlowActive(true);
      setDismissedFundingModal(false);
      setIsContinuing(false);
    }
  }, [
    onboardingStatus?.onboarding_completed,
    onboardingStatus?.steps.wallet,
    onboardingStatus?.steps.funded,
    fundingFlowActive,
  ]);

  const copyFundingAddress = async (address: string) => {
    await navigator.clipboard.writeText(address);
    setCopiedFundingAddress(address);
    setTimeout(() => setCopiedFundingAddress(null), 2000);
  };

  const {
    data: wallets,
    isLoading: walletsLoading,
    mutate: mutateWallets,
  } = useSWR<Wallet[]>(
    currentOrg ? `/api/wallets/organization/${currentOrg.id}` : null,
    api.get,
  );

  const firstWalletSolanaAddress = wallets?.[0]
    ? extractAddresses(wallets[0].wallet_config).solana
    : null;

  const showFundingModal =
    !dismissedFundingModal &&
    !walletsLoading &&
    (forceShowFundingModal || fundingFlowActive);

  const { data: fundingModalBalances } = useSWR<WalletBalancesResponse>(
    showFundingModal && wallets?.[0]
      ? `/api/wallets/${wallets[0].id}/balances`
      : null,
    api.get,
    { refreshInterval: 5000 },
  );

  const isSolanaFunded = fundingModalBalances?.isFunded ?? false;
  const hasSol =
    parseFloat(fundingModalBalances?.solana?.native ?? "0") >= 0.001;
  const hasUsdc = parseFloat(fundingModalBalances?.solana?.usdc ?? "0") >= 0.01;

  const handleFundingEditSave = async (data: {
    name: string;
    solana?: string;
    evm?: string;
  }) => {
    if (!wallets?.[0] || !currentOrg) return;
    setIsSavingFundingEdit(true);
    try {
      const walletConfig = buildAddressOnlyConfig({
        solana: data.solana,
        evm: data.evm,
      });
      await api.put(`/api/wallets/${wallets[0].id}`, {
        name: data.name,
        wallet_config: walletConfig,
      });
      await mutateWallets();
      setShowFundingEditModal(false);
      setDismissedFundingModal(false);
      setForceShowFundingModal(true);
    } catch {
      toast({
        title: "Error",
        description: "Failed to update wallet",
        variant: "error",
      });
    }
    setIsSavingFundingEdit(false);
  };

  const handleCreateWallet = async (data: {
    name: string;
    solana?: string;
    evm?: string;
  }) => {
    if (!currentOrg) return;
    setIsSaving(true);
    try {
      const walletConfig = buildAddressOnlyConfig({
        solana: data.solana,
        evm: data.evm,
      });
      await api.post(`/api/wallets/organization/${currentOrg.id}`, {
        name: data.name,
        wallet_config: walletConfig,
      });
      await mutateWallets();
      refreshOnboardingStatus(currentOrg.id);
      setShowCreateModal(false);
      toast({
        title: "Wallet created",
        description: "Your wallet has been created successfully.",
        variant: "success",
      });
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to create wallet",
        variant: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditWallet = async (
    wallet: Wallet,
    data: { name: string; solana?: string; evm?: string },
  ) => {
    try {
      const walletConfig = buildAddressOnlyConfig({
        solana: data.solana,
        evm: data.evm,
      });
      await api.put(`/api/wallets/${wallet.id}`, {
        name: data.name,
        wallet_config: walletConfig,
      });
      await mutateWallets();
      toast({
        title: "Wallet updated",
        description: "Your wallet has been updated.",
        variant: "success",
      });
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to update wallet",
        variant: "error",
      });
    }
  };

  const handleDeleteClick = async (wallet: Wallet) => {
    setWalletToDelete(wallet);
    try {
      const tenants = await api.get<
        { id: number; name: string; wallet_id: number | null }[]
      >(`/api/organizations/${currentOrg?.id}/tenants`);
      const usingWallet = tenants.filter((t) => t.wallet_id === wallet.id);
      if (usingWallet.length > 0) {
        setTenantsUsingWallet(usingWallet.map((t) => t.name));
        setShowInUseDialog(true);
      } else {
        setDeleteDialogOpen(true);
      }
    } catch {
      setDeleteDialogOpen(true);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!walletToDelete) return;
    setIsDeleting(true);
    try {
      await api.delete(`/api/wallets/${walletToDelete.id}`);
      await mutateWallets();
      setDeleteDialogOpen(false);
      setWalletToDelete(null);
      toast({
        title: "Wallet deleted",
        description: "The wallet has been deleted.",
        variant: "success",
      });
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

  if (!currentOrg) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-11">Select an organization to view wallets</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-12">Wallets</h1>
          <p className="text-sm text-gray-11">
            Manage crypto wallets for{" "}
            <span className="text-brand-orange">{currentOrg.name}</span>
          </p>
        </div>
        {isOwner && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90"
          >
            <PlusIcon className="h-4 w-4" />
            New Wallet
          </button>
        )}
      </div>

      {walletsLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
        </div>
      ) : wallets?.length ? (
        <div className="space-y-4">
          {wallets.map((wallet) => (
            <WalletCard
              key={wallet.id}
              wallet={wallet}
              isOwner={isOwner ?? false}
              onEdit={handleEditWallet}
              onDelete={(wallet) => void handleDeleteClick(wallet)}
              organizationId={currentOrg.id}
            />
          ))}
        </div>
      ) : isOwner ? (
        <div className="rounded-lg border border-gray-6 bg-gray-2 p-8 text-center">
          <h2 className="mb-2 text-lg font-medium text-gray-12">
            No wallets configured
          </h2>
          <p className="mb-6 text-sm text-gray-11 max-w-md mx-auto">
            Add your wallet addresses to receive payments on Solana and EVM
            chains.
          </p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-2 rounded-md bg-white px-6 py-2.5 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90"
          >
            <PlusIcon className="h-4 w-4" />
            Create your first wallet
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-gray-6 bg-gray-2 p-8 text-center">
          <h2 className="mb-2 text-lg font-medium text-gray-12">
            No wallets configured
          </h2>
          <p className="text-sm text-amber-400">
            Only organization owners can configure wallets.
          </p>
        </div>
      )}

      <CreateWalletModal
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
        onSave={(data) => void handleCreateWallet(data)}
        isSaving={isSaving}
        organizationId={currentOrg.id}
      />

      <Dialog.Root open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-lg">
            <div className="flex items-center justify-between">
              <Dialog.Title className="text-lg font-semibold text-gray-12">
                Delete Wallet
              </Dialog.Title>
              <Dialog.Close className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12">
                <Cross2Icon className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <Dialog.Description asChild>
              <div className="mt-4 space-y-3 text-sm text-gray-11">
                <p>
                  Are you sure you want to delete{" "}
                  <span className="font-medium text-gray-12">
                    {walletToDelete?.name}
                  </span>
                  ?
                </p>
                <p>This action cannot be undone.</p>
              </div>
            </Dialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setDeleteDialogOpen(false)}
                className="rounded-md px-3 py-2 text-sm font-medium text-gray-11 hover:bg-gray-4 hover:text-gray-12"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDeleteConfirm()}
                disabled={isDeleting}
                className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={showInUseDialog} onOpenChange={setShowInUseDialog}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-lg">
            <div className="flex items-center justify-between">
              <Dialog.Title className="text-lg font-semibold text-gray-12">
                Cannot Delete Wallet
              </Dialog.Title>
              <Dialog.Close className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12">
                <Cross2Icon className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <Dialog.Description asChild>
              <div className="mt-4 space-y-3 text-sm text-gray-11">
                <p>
                  <span className="font-medium text-gray-12">
                    {walletToDelete?.name}
                  </span>{" "}
                  is currently assigned to{" "}
                  {tenantsUsingWallet.length === 1 ? "a proxy" : "proxies"}:
                </p>
                <ul className="list-disc list-inside space-y-1">
                  {tenantsUsingWallet.map((name) => (
                    <li key={name} className="text-gray-12">
                      {name}
                    </li>
                  ))}
                </ul>
                <p>
                  Reassign{" "}
                  {tenantsUsingWallet.length === 1
                    ? "this proxy"
                    : "these proxies"}{" "}
                  to a different wallet before deleting.
                </p>
              </div>
            </Dialog.Description>
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowInUseDialog(false)}
                className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-white/90"
              >
                OK
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={showFundingModal}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-brand-orange bg-gray-1 p-6 shadow-xl focus:outline-none"
            onPointerDownOutside={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => e.preventDefault()}
          >
            <Dialog.Title className="text-lg font-semibold text-gray-12">
              Fund Your Wallet to Continue
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-gray-11">
              Send funds to your wallet address below to enable proxy creation.
              Your balance will update automatically once funds are received.
            </Dialog.Description>

            <div className="mt-6 space-y-4">
              {!wallets?.length ? (
                <div className="rounded-lg border border-yellow-800 bg-yellow-900/20 p-4 text-center">
                  <p className="text-sm text-yellow-400 mb-3">
                    No wallet configured
                  </p>
                  <button
                    onClick={() => setShowCreateModal(true)}
                    className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-white/90"
                  >
                    Create Wallet
                  </button>
                </div>
              ) : (
                (() => {
                  const addresses = extractAddresses(wallets[0].wallet_config);
                  return (
                    <>
                      {addresses.solana ? (
                        <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
                          <div className="flex gap-4">
                            <div className="flex-shrink-0 rounded-lg bg-white p-2">
                              <QRCodeSVG
                                value={addresses.solana}
                                size={100}
                                level="M"
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="flex items-center gap-2 text-sm font-medium text-gray-12 mb-2">
                                <span>Solana Address</span>
                                {isSolanaFunded && (
                                  <CheckCircledIcon className="h-4 w-4 text-green-400" />
                                )}
                                <button
                                  onClick={() => setShowFundingEditModal(true)}
                                  className="ml-auto text-xs text-gray-11 hover:text-gray-12 focus:outline-none"
                                >
                                  Change
                                </button>
                              </p>
                              <div className="flex items-center gap-2">
                                <code className="flex-1 rounded border border-gray-6 bg-gray-3 px-2 py-1 font-mono text-xs text-gray-12 truncate">
                                  {addresses.solana}
                                </code>
                                <button
                                  onClick={() =>
                                    void copyFundingAddress(
                                      addresses.solana ?? "",
                                    )
                                  }
                                  className="rounded p-1.5 text-gray-11 hover:bg-gray-3 hover:text-gray-12 focus:outline-none"
                                >
                                  {copiedFundingAddress === addresses.solana ? (
                                    <CheckIcon className="h-4 w-4 text-green-400" />
                                  ) : (
                                    <CopyIcon className="h-4 w-4" />
                                  )}
                                </button>
                              </div>
                              <div className="mt-3 space-y-1">
                                <p className="text-xs font-medium text-gray-11">
                                  Send both to this address:
                                </p>
                                <div className="flex items-center gap-2 text-sm">
                                  <div className="flex h-4 w-4 items-center justify-center flex-shrink-0">
                                    {hasSol ? (
                                      <CheckCircledIcon className="h-4 w-4 text-green-400" />
                                    ) : (
                                      <div className="h-2 w-2 rounded-full bg-brand-orange" />
                                    )}
                                  </div>
                                  <span
                                    className={
                                      hasSol
                                        ? "text-green-400"
                                        : "text-brand-orange font-medium"
                                    }
                                  >
                                    SOL — for transaction fees
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 text-sm">
                                  <div className="flex h-4 w-4 items-center justify-center flex-shrink-0">
                                    {hasUsdc ? (
                                      <CheckCircledIcon className="h-4 w-4 text-green-400" />
                                    ) : (
                                      <div className="h-2 w-2 rounded-full bg-brand-orange" />
                                    )}
                                  </div>
                                  <span
                                    className={
                                      hasUsdc
                                        ? "text-green-400"
                                        : "text-brand-orange font-medium"
                                    }
                                  >
                                    USDC — for proxy payments
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-yellow-800 bg-yellow-900/20 p-4 text-center">
                          <p className="text-sm text-yellow-400 mb-3">
                            No Solana address configured
                          </p>
                          <button
                            onClick={() => setShowFundingEditModal(true)}
                            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-white/90"
                          >
                            Add Solana Address
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()
              )}
            </div>

            <div className="mt-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isSolanaFunded ? (
                    <>
                      <CheckCircledIcon className="h-5 w-5 text-green-400" />
                      <span className="text-sm text-green-400">
                        Funds received!
                      </span>
                    </>
                  ) : (
                    <>
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-6 border-t-brand-orange" />
                      <span className="text-sm text-gray-11">
                        {!hasSol && !hasUsdc
                          ? "Waiting for SOL and USDC..."
                          : !hasUsdc
                            ? "Waiting for USDC..."
                            : !hasSol
                              ? "Waiting for SOL..."
                              : "Confirming..."}
                      </span>
                    </>
                  )}
                </div>
                <button
                  onClick={() => {
                    setIsContinuing(true);
                    void import("@hiseb/confetti").then(
                      ({ default: confetti }) => {
                        confetti({
                          position: {
                            x: window.innerWidth * 0.5,
                            y: window.innerHeight * 0.4,
                          },
                          count: 150,
                          velocity: 200,
                        });
                      },
                    );
                    setTimeout(() => {
                      router.push("/proxies");
                      refreshOnboardingStatus(currentOrg?.id ?? 0);
                    }, 3000);
                    setTimeout(() => {
                      setDismissedFundingModal(true);
                      setForceShowFundingModal(false);
                      setFundingFlowActive(false);
                    }, 4000);
                  }}
                  disabled={!isSolanaFunded || isContinuing}
                  className="inline-flex items-center gap-2 rounded-md bg-brand-orange px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-orange/90 disabled:opacity-70"
                >
                  Continue
                  {isContinuing ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : (
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M13 7l5 5m0 0l-5 5m5-5H6"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {wallets?.[0] && (
        <EditWalletModal
          open={showFundingEditModal}
          onOpenChange={setShowFundingEditModal}
          onSave={(data) => void handleFundingEditSave(data)}
          isSaving={isSavingFundingEdit}
          initialName={wallets[0].name}
          initialSolana={firstWalletSolanaAddress ?? ""}
          initialEvm={extractAddresses(wallets[0].wallet_config).evm ?? ""}
          walletId={wallets[0].id}
          organizationId={currentOrg?.id ?? 0}
        />
      )}
    </div>
  );
}
