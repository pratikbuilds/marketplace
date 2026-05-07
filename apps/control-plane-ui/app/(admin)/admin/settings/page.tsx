"use client";

import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/lib/auth/context";
import useSWR from "swr";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  CopyIcon,
  CheckIcon,
  ReloadIcon,
  CheckCircledIcon,
  CrossCircledIcon,
  EyeOpenIcon,
  EyeClosedIcon,
  PlusIcon,
  MinusIcon,
  Pencil1Icon,
  Cross2Icon,
} from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import {
  buildWalletConfig,
  deriveSolanaAddress,
  deriveEvmAddress,
  type EcosystemConfig,
} from "@/lib/wallet";
import { useToast } from "@/components/ui/toast";

interface AdminSettings {
  hasWallet: boolean;
  addresses: {
    solana: string | null;
    evm: string | null;
  };
  minimumBalanceSol: number;
  minimumBalanceUsdc: number;
  updatedAt: string;
}

interface EmailSettings {
  configured: boolean;
  from_email: string | null;
  site_url: string | null;
  has_api_key: boolean;
  template_ids: {
    verification: number;
    welcome: number;
    invitation: number;
    password_reset: number;
  } | null;
  custom_variables: Record<string, string> | null;
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

const CHAINS = [
  { id: "solana", name: "Solana", native: "SOL" },
  { id: "base", name: "Base", native: "ETH" },
  { id: "polygon", name: "Polygon", native: "MATIC" },
  { id: "monad", name: "Monad", native: "MON" },
] as const;

type WalletMode = "generate" | "import";

function WalletSetupModal({
  open,
  onOpenChange,
  onSave,
  isSaving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: EcosystemConfig) => void;
  isSaving: boolean;
}) {
  const [solanaMode, setSolanaMode] = useState<WalletMode>("generate");
  const [evmMode, setEvmMode] = useState<WalletMode>("generate");
  const [solanaKey, setSolanaKey] = useState("");
  const [evmKey, setEvmKey] = useState("");
  const [showSolanaKey, setShowSolanaKey] = useState(false);
  const [showEvmKey, setShowEvmKey] = useState(false);

  const [solanaDerivation, setSolanaDerivation] = useState<{
    address: string;
    key: string;
  } | null>(null);
  useEffect(() => {
    if (!solanaKey) {
      setSolanaDerivation(null);
      return;
    }
    let cancelled = false;
    void deriveSolanaAddress(solanaKey).then((result) => {
      if (!cancelled) setSolanaDerivation(result);
    });
    return () => {
      cancelled = true;
    };
  }, [solanaKey]);

  const evmDerivation = useMemo(() => {
    if (!evmKey) return null;
    return deriveEvmAddress(evmKey);
  }, [evmKey]);

  const solanaValid =
    solanaMode === "generate" ||
    (solanaMode === "import" && solanaDerivation !== null);
  const evmValid =
    evmMode === "generate" || (evmMode === "import" && evmDerivation !== null);
  const canSave = solanaValid && evmValid;

  const handleSave = () => {
    onSave({
      solana:
        solanaMode === "generate"
          ? { mode: "generate" }
          : { mode: "import", key: solanaKey },
      evm:
        evmMode === "generate"
          ? { mode: "generate" }
          : { mode: "import", key: evmKey },
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-1 p-6 shadow-xl max-h-[85vh] overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold text-gray-12">
            Configure Master Wallet
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-11">
            Set up the platform wallet for receiving fees.
          </Dialog.Description>

          <div className="mt-6 space-y-5">
            {/* Solana */}
            <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-gray-12">Solana</span>
                <div className="flex gap-1 rounded-md border border-gray-6 bg-gray-3 p-0.5">
                  <button
                    onClick={() => setSolanaMode("generate")}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      solanaMode === "generate"
                        ? "bg-gray-6 text-gray-12"
                        : "text-gray-11 hover:text-gray-12"
                    }`}
                  >
                    Generate
                  </button>
                  <button
                    onClick={() => setSolanaMode("import")}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      solanaMode === "import"
                        ? "bg-gray-6 text-gray-12"
                        : "text-gray-11 hover:text-gray-12"
                    }`}
                  >
                    Import
                  </button>
                </div>
              </div>

              {solanaMode === "generate" ? (
                <p className="text-xs text-gray-11">
                  A new Solana wallet will be generated.
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      type={showSolanaKey ? "text" : "password"}
                      value={solanaKey}
                      onChange={(e) => setSolanaKey(e.target.value)}
                      placeholder="Private key (Base58 or JSON array)"
                      className={`w-full rounded-md border bg-gray-3 px-3 py-2 pr-10 font-mono text-xs text-gray-12 placeholder:text-gray-8 focus:outline-none ${
                        solanaKey && !solanaDerivation
                          ? "border-red-500 focus:border-red-500"
                          : "border-gray-6 focus:border-accent-8"
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowSolanaKey(!showSolanaKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-11 hover:text-gray-12"
                    >
                      {showSolanaKey ? (
                        <EyeClosedIcon className="h-4 w-4" />
                      ) : (
                        <EyeOpenIcon className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    {solanaKey ? (
                      solanaDerivation ? (
                        <>
                          <CheckCircledIcon className="h-3.5 w-3.5 text-green-400" />
                          <code className="text-gray-12 font-mono truncate">
                            {solanaDerivation.address}
                          </code>
                        </>
                      ) : (
                        <>
                          <CrossCircledIcon className="h-3.5 w-3.5 text-red-400" />
                          <span className="text-red-400">
                            Invalid key format
                          </span>
                        </>
                      )
                    ) : (
                      <span className="text-gray-11">
                        Enter private key to continue
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* EVM */}
            <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <span className="text-sm font-medium text-gray-12">EVM</span>
                  <span className="text-xs text-gray-11 ml-2">
                    Base, Polygon, Monad
                  </span>
                </div>
                <div className="flex gap-1 rounded-md border border-gray-6 bg-gray-3 p-0.5">
                  <button
                    onClick={() => setEvmMode("generate")}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      evmMode === "generate"
                        ? "bg-gray-6 text-gray-12"
                        : "text-gray-11 hover:text-gray-12"
                    }`}
                  >
                    Generate
                  </button>
                  <button
                    onClick={() => setEvmMode("import")}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      evmMode === "import"
                        ? "bg-gray-6 text-gray-12"
                        : "text-gray-11 hover:text-gray-12"
                    }`}
                  >
                    Import
                  </button>
                </div>
              </div>

              {evmMode === "generate" ? (
                <p className="text-xs text-gray-11">
                  A new EVM wallet will be generated (same address across all
                  EVM chains).
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      type={showEvmKey ? "text" : "password"}
                      value={evmKey}
                      onChange={(e) => setEvmKey(e.target.value)}
                      placeholder="Private key (hex, with or without 0x)"
                      className={`w-full rounded-md border bg-gray-3 px-3 py-2 pr-10 font-mono text-xs text-gray-12 placeholder:text-gray-8 focus:outline-none ${
                        evmKey && !evmDerivation
                          ? "border-red-500 focus:border-red-500"
                          : "border-gray-6 focus:border-accent-8"
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowEvmKey(!showEvmKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-11 hover:text-gray-12"
                    >
                      {showEvmKey ? (
                        <EyeClosedIcon className="h-4 w-4" />
                      ) : (
                        <EyeOpenIcon className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    {evmKey ? (
                      evmDerivation ? (
                        <>
                          <CheckCircledIcon className="h-3.5 w-3.5 text-green-400" />
                          <code className="text-gray-12 font-mono truncate">
                            {evmDerivation.address}
                          </code>
                        </>
                      ) : (
                        <>
                          <CrossCircledIcon className="h-3.5 w-3.5 text-red-400" />
                          <span className="text-red-400">
                            Invalid key format
                          </span>
                        </>
                      )
                    ) : (
                      <span className="text-gray-11">
                        Enter private key to continue
                      </span>
                    )}
                  </div>
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
              {isSaving ? "Saving..." : "Save Wallet"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FundingAmountEditor({
  label,
  description,
  currentAmount,
  unit,
  min,
  max,
  step,
  onSave,
  isSaving,
}: {
  label: string;
  description: string;
  currentAmount: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onSave: (amount: number) => Promise<void>;
  isSaving: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState((currentAmount ?? min).toString());

  const handleSave = async () => {
    const amount = parseFloat(value);
    if (isNaN(amount) || amount < min || amount > max) {
      return;
    }
    await onSave(amount);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setValue((currentAmount ?? min).toString());
    setIsEditing(false);
  };

  const increment = () => {
    const current = parseFloat(value) || 0;
    const newVal = Math.min(max, current + step);
    setValue(newVal.toString());
  };

  const decrement = () => {
    const current = parseFloat(value) || 0;
    const newVal = Math.max(min, current - step);
    setValue(newVal.toString());
  };

  return (
    <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
      <label className="mb-2 block text-sm text-gray-11">{label}</label>
      {isEditing ? (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-0 rounded-md border border-gray-6 bg-gray-3">
            <button
              type="button"
              onClick={decrement}
              className="flex h-9 w-9 items-center justify-center text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors rounded-l-md"
            >
              <MinusIcon className="h-4 w-4" />
            </button>
            <div className="flex items-center">
              <input
                type="text"
                inputMode="decimal"
                value={value}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "" || /^\d*\.?\d*$/.test(val)) {
                    setValue(val);
                  }
                }}
                className="w-20 bg-transparent py-2 text-center text-sm text-gray-12 focus:outline-none"
              />
              <span className="pr-2 text-xs text-gray-11">{unit}</span>
            </div>
            <button
              type="button"
              onClick={increment}
              className="flex h-9 w-9 items-center justify-center text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors rounded-r-md"
            >
              <PlusIcon className="h-4 w-4" />
            </button>
          </div>
          <button
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="inline-flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black disabled:opacity-50"
          >
            <CheckIcon className="h-3 w-3" />
            {isSaving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={handleCancel}
            className="inline-flex items-center gap-1 rounded-md border border-gray-6 px-3 py-1.5 text-sm text-gray-11 hover:bg-gray-3"
          >
            <Cross2Icon className="h-3 w-3" />
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setIsEditing(true)}
          className="group flex items-center gap-2"
        >
          <span className="text-2xl font-semibold text-gray-12">
            {currentAmount ?? min} {unit}
          </span>
          <Pencil1Icon className="h-4 w-4 text-gray-8 opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
      )}
      <p className="mt-2 text-xs text-gray-11">{description}</p>
    </div>
  );
}

function MasterWalletDisplay({
  settings,
  balances,
  balancesLoading,
  mutateBalances,
  onConfigureWallet,
}: {
  settings: AdminSettings;
  balances: WalletBalances | undefined;
  balancesLoading: boolean;
  mutateBalances: () => Promise<WalletBalances | undefined>;
  onConfigureWallet: () => void;
}) {
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  const solanaAddress = settings.addresses.solana;
  const evmAddress = settings.addresses.evm;

  const availableChains = CHAINS.filter((chain) => {
    if (chain.id === "solana") return solanaAddress !== null;
    return evmAddress !== null;
  });

  if (!settings.hasWallet) {
    return (
      <div className="rounded-lg border border-gray-6 bg-gray-2 p-6 text-center">
        <h3 className="mb-2 text-lg font-medium text-gray-12">
          No master wallet configured
        </h3>
        <p className="mb-4 text-sm text-gray-11">
          Set up a wallet to receive platform fees.
        </p>
        <button
          onClick={onConfigureWallet}
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90"
        >
          Configure Wallet
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-12">Master Wallet</h3>
        <div className="flex gap-2">
          <button
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            className="flex items-center gap-2 rounded-md border border-gray-6 px-3 py-1.5 text-sm text-gray-11 hover:bg-gray-3 disabled:opacity-50"
          >
            <ReloadIcon
              className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`}
            />
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button
            onClick={onConfigureWallet}
            className="rounded-md border border-gray-6 px-3 py-1.5 text-sm text-gray-11 hover:bg-gray-3"
          >
            Reconfigure
          </button>
        </div>
      </div>

      {/* Addresses */}
      <div className="space-y-3">
        {solanaAddress && (
          <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
            <label className="block text-xs text-gray-11 mb-2">
              Solana Address
            </label>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border border-gray-6 bg-gray-3 px-3 py-2 font-mono text-sm text-gray-12 overflow-hidden text-ellipsis">
                {solanaAddress}
              </code>
              <Tooltip.Provider delayDuration={200}>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <button
                      onClick={() => void copyToClipboard(solanaAddress)}
                      className="rounded-md border border-gray-6 p-2 text-gray-11 hover:bg-gray-3 hover:text-gray-12"
                    >
                      {copiedAddress === solanaAddress ? (
                        <CheckIcon className="h-4 w-4 text-green-400" />
                      ) : (
                        <CopyIcon className="h-4 w-4" />
                      )}
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="rounded bg-gray-12 px-2 py-1 text-xs text-gray-1"
                      sideOffset={5}
                    >
                      {copiedAddress === solanaAddress ? "Copied!" : "Copy"}
                      <Tooltip.Arrow className="fill-gray-12" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            </div>
          </div>
        )}

        {evmAddress && (
          <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
            <label className="block text-xs text-gray-11 mb-2">
              EVM Address{" "}
              <span className="text-gray-8">(Base, Polygon, Monad)</span>
            </label>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border border-gray-6 bg-gray-3 px-3 py-2 font-mono text-sm text-gray-12 overflow-hidden text-ellipsis">
                {evmAddress}
              </code>
              <Tooltip.Provider delayDuration={200}>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <button
                      onClick={() => void copyToClipboard(evmAddress)}
                      className="rounded-md border border-gray-6 p-2 text-gray-11 hover:bg-gray-3 hover:text-gray-12"
                    >
                      {copiedAddress === evmAddress ? (
                        <CheckIcon className="h-4 w-4 text-green-400" />
                      ) : (
                        <CopyIcon className="h-4 w-4" />
                      )}
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="rounded bg-gray-12 px-2 py-1 text-xs text-gray-1"
                      sideOffset={5}
                    >
                      {copiedAddress === evmAddress ? "Copied!" : "Copy"}
                      <Tooltip.Arrow className="fill-gray-12" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            </div>
          </div>
        )}
      </div>

      {/* Balances Grid */}
      {availableChains.length > 0 && (
        <div>
          <label className="block text-xs text-gray-11 mb-2">Balances</label>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {availableChains.map((chain) => {
              const chainBalances = getBalancesForChain(chain.id);
              return (
                <div
                  key={chain.id}
                  className="rounded-lg border border-gray-6 bg-gray-2 p-4"
                >
                  <p className="text-sm font-medium text-gray-12 mb-3">
                    {chain.name}
                  </p>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-11">
                        {chain.native}
                      </span>
                      <span className="font-mono text-sm text-gray-12">
                        {balancesLoading || isRefreshing ? (
                          <span className="inline-block h-4 w-12 animate-pulse rounded bg-gray-5" />
                        ) : (
                          (chainBalances?.native ?? "-")
                        )}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-11">USDC</span>
                      <span className="font-mono text-sm text-gray-12">
                        {balancesLoading || isRefreshing ? (
                          <span className="inline-block h-4 w-12 animate-pulse rounded bg-gray-5" />
                        ) : chainBalances?.usdc ? (
                          `$${chainBalances.usdc}`
                        ) : (
                          "-"
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function EmailSettingsSection({
  emailSettings,
  isLoading,
  onSave,
  isSaving,
}: {
  emailSettings: EmailSettings | undefined;
  isLoading: boolean;
  onSave: (data: {
    from_email?: string;
    site_url?: string;
    template_ids?: {
      verification?: number;
      welcome?: number;
      invitation?: number;
      password_reset?: number;
    };
    custom_variables?: Record<string, string>;
  }) => Promise<void>;
  isSaving: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [fromEmail, setFromEmail] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [verificationId, setVerificationId] = useState("");
  const [welcomeId, setWelcomeId] = useState("");
  const [invitationId, setInvitationId] = useState("");
  const [passwordResetId, setPasswordResetId] = useState("");
  const [customVars, setCustomVars] = useState<
    { key: string; value: string }[]
  >([]);
  const [validationError, setValidationError] = useState("");

  const handleEdit = () => {
    setFromEmail(emailSettings?.from_email ?? "");
    setSiteUrl(emailSettings?.site_url ?? "");
    setVerificationId(
      emailSettings?.template_ids?.verification?.toString() ?? "",
    );
    setWelcomeId(emailSettings?.template_ids?.welcome?.toString() ?? "");
    setInvitationId(emailSettings?.template_ids?.invitation?.toString() ?? "");
    setPasswordResetId(
      emailSettings?.template_ids?.password_reset?.toString() ?? "",
    );
    setCustomVars(
      emailSettings?.custom_variables
        ? Object.entries(emailSettings.custom_variables).map(
            ([key, value]) => ({
              key,
              value,
            }),
          )
        : [],
    );
    setValidationError("");
    setIsEditing(true);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setValidationError("");
  };

  const isValidTemplateId = (value: string): boolean => {
    if (!value) return true;
    const parsed = parseInt(value, 10);
    return !isNaN(parsed) && parsed >= 0 && String(parsed) === value.trim();
  };

  const parseTemplateId = (value: string): number | undefined => {
    if (!value) return undefined;
    const parsed = parseInt(value, 10);
    return parsed;
  };

  const handleSave = async () => {
    const invalidFields: string[] = [];
    if (!isValidTemplateId(verificationId)) invalidFields.push("Verification");
    if (!isValidTemplateId(welcomeId)) invalidFields.push("Welcome");
    if (!isValidTemplateId(invitationId)) invalidFields.push("Invitation");
    if (!isValidTemplateId(passwordResetId))
      invalidFields.push("Password Reset");

    if (invalidFields.length > 0) {
      setValidationError(
        `Invalid template ID for: ${invalidFields.join(", ")}`,
      );
      return;
    }

    setValidationError("");
    const customVariables: Record<string, string> = {};
    for (const { key, value } of customVars) {
      if (key.trim()) {
        customVariables[key.trim()] = value;
      }
    }
    await onSave({
      from_email: fromEmail || undefined,
      site_url: siteUrl || undefined,
      template_ids: {
        verification: parseTemplateId(verificationId),
        welcome: parseTemplateId(welcomeId),
        invitation: parseTemplateId(invitationId),
        password_reset: parseTemplateId(passwordResetId),
      },
      custom_variables: customVariables,
    });
    setIsEditing(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-12">Email Settings</h3>
          <p className="text-xs text-gray-11 mt-1">
            Configure Postmark email delivery for verification, invitations, and
            password resets.
          </p>
        </div>
        {!isEditing && (
          <button
            onClick={handleEdit}
            className="flex items-center gap-2 rounded-md border border-gray-6 px-3 py-1.5 text-sm text-gray-11 hover:bg-gray-3"
          >
            <Pencil1Icon className="h-3.5 w-3.5" />
            {emailSettings?.configured ? "Edit" : "Configure"}
          </button>
        )}
      </div>

      {!emailSettings?.has_api_key && (
        <div className="rounded-lg border border-amber-800 bg-amber-900/20 p-4">
          <p className="text-sm text-amber-400">
            POSTMARK_API_KEY environment variable is not set. Emails will not be
            sent until this is configured on the server.
          </p>
        </div>
      )}

      {isEditing ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
            <label className="block text-xs text-gray-11 mb-2">
              From Email Address
            </label>
            <input
              type="email"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="noreply@example.com"
              className="w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8 focus:outline-none focus:border-accent-8"
            />
          </div>

          <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
            <label className="block text-xs text-gray-11 mb-2">Site URL</label>
            <input
              type="url"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8 focus:outline-none focus:border-accent-8"
            />
            <p className="mt-1 text-xs text-gray-11">
              Base URL for links in emails (verification, password reset, etc.)
            </p>
          </div>

          <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
            <label className="block text-xs text-gray-11 mb-3">
              Postmark Template IDs
            </label>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-11 mb-1">
                  Email Verification
                </label>
                <input
                  type="text"
                  value={verificationId}
                  onChange={(e) => setVerificationId(e.target.value)}
                  placeholder="Template ID"
                  className="w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8 focus:outline-none focus:border-accent-8"
                />
                <p className="mt-1 text-xs text-gray-8">
                  Variables:{" "}
                  <code className="text-gray-11">verification_url</code>,{" "}
                  <code className="text-gray-11">user_email</code>
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-11 mb-1">
                  Welcome
                </label>
                <input
                  type="text"
                  value={welcomeId}
                  onChange={(e) => setWelcomeId(e.target.value)}
                  placeholder="Template ID"
                  className="w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8 focus:outline-none focus:border-accent-8"
                />
                <p className="mt-1 text-xs text-gray-8">
                  Variables: <code className="text-gray-11">user_email</code>,{" "}
                  <code className="text-gray-11">login_url</code>
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-11 mb-1">
                  Organization Invitation
                </label>
                <input
                  type="text"
                  value={invitationId}
                  onChange={(e) => setInvitationId(e.target.value)}
                  placeholder="Template ID"
                  className="w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8 focus:outline-none focus:border-accent-8"
                />
                <p className="mt-1 text-xs text-gray-8">
                  Variables:{" "}
                  <code className="text-gray-11">invitation_url</code>,{" "}
                  <code className="text-gray-11">organization_name</code>,{" "}
                  <code className="text-gray-11">inviter_email</code>,{" "}
                  <code className="text-gray-11">role</code>
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-11 mb-1">
                  Password Reset
                </label>
                <input
                  type="text"
                  value={passwordResetId}
                  onChange={(e) => setPasswordResetId(e.target.value)}
                  placeholder="Template ID"
                  className="w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8 focus:outline-none focus:border-accent-8"
                />
                <p className="mt-1 text-xs text-gray-8">
                  Variables: <code className="text-gray-11">reset_url</code>,{" "}
                  <code className="text-gray-11">user_email</code>,{" "}
                  <code className="text-gray-11">expires_in_hours</code>
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-12">
                Custom Variables
              </span>
              <button
                type="button"
                onClick={() =>
                  setCustomVars([...customVars, { key: "", value: "" }])
                }
                className="text-xs text-accent-9 hover:text-accent-10"
              >
                + Add Variable
              </button>
            </div>
            <p className="text-xs text-gray-8 mb-3">
              These variables are passed to all email templates.
            </p>
            <div className="space-y-2">
              {customVars.map((cv, index) => (
                <div key={index} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={cv.key}
                    onChange={(e) => {
                      const updated = [...customVars];
                      updated[index] = { ...cv, key: e.target.value };
                      setCustomVars(updated);
                    }}
                    placeholder="Variable name"
                    className="flex-1 rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8 focus:outline-none focus:border-accent-8"
                  />
                  <input
                    type="text"
                    value={cv.value}
                    onChange={(e) => {
                      const updated = [...customVars];
                      updated[index] = { ...cv, value: e.target.value };
                      setCustomVars(updated);
                    }}
                    placeholder="Value"
                    className="flex-1 rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8 focus:outline-none focus:border-accent-8"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setCustomVars(customVars.filter((_, i) => i !== index));
                    }}
                    className="p-2 text-gray-8 hover:text-red-500"
                  >
                    <Cross2Icon className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {customVars.length === 0 && (
                <p className="text-xs text-gray-8 italic">
                  No custom variables configured
                </p>
              )}
            </div>
          </div>

          {validationError && (
            <p className="text-sm text-red-500">{validationError}</p>
          )}

          <div className="flex justify-end gap-3">
            <button
              onClick={handleCancel}
              className="rounded-md border border-gray-6 px-4 py-2 text-sm text-gray-11 hover:bg-gray-3"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={isSaving}
              className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90 disabled:opacity-50"
            >
              {isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
            <label className="block text-xs text-gray-11 mb-1">
              From Email
            </label>
            <p className="text-sm text-gray-12">
              {emailSettings?.from_email ?? (
                <span className="text-gray-8">Not configured</span>
              )}
            </p>
          </div>

          <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
            <label className="block text-xs text-gray-11 mb-1">Site URL</label>
            <p className="text-sm text-gray-12">
              {emailSettings?.site_url ?? (
                <span className="text-gray-8">Not configured</span>
              )}
            </p>
          </div>

          <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
            <label className="block text-xs text-gray-11 mb-2">
              Template IDs
            </label>
            <div className="grid gap-2 sm:grid-cols-4">
              <div>
                <span className="text-xs text-gray-11">Verification</span>
                <p className="text-sm font-mono text-gray-12">
                  {emailSettings?.template_ids?.verification ?? (
                    <span className="text-gray-8">-</span>
                  )}
                </p>
              </div>
              <div>
                <span className="text-xs text-gray-11">Welcome</span>
                <p className="text-sm font-mono text-gray-12">
                  {emailSettings?.template_ids?.welcome ?? (
                    <span className="text-gray-8">-</span>
                  )}
                </p>
              </div>
              <div>
                <span className="text-xs text-gray-11">Invitation</span>
                <p className="text-sm font-mono text-gray-12">
                  {emailSettings?.template_ids?.invitation ?? (
                    <span className="text-gray-8">-</span>
                  )}
                </p>
              </div>
              <div>
                <span className="text-xs text-gray-11">Password Reset</span>
                <p className="text-sm font-mono text-gray-12">
                  {emailSettings?.template_ids?.password_reset ?? (
                    <span className="text-gray-8">-</span>
                  )}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
            <label className="block text-xs text-gray-11 mb-2">
              Custom Variables
            </label>
            {emailSettings?.custom_variables &&
            Object.keys(emailSettings.custom_variables).length > 0 ? (
              <div className="space-y-1">
                {Object.entries(emailSettings.custom_variables).map(
                  ([key, value]) => (
                    <div key={key} className="flex gap-2 text-sm">
                      <span className="font-mono text-gray-11">{key}:</span>
                      <span className="text-gray-12">{value}</span>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-8">No custom variables</p>
            )}
          </div>

          <div className="flex items-center gap-2 text-sm">
            {emailSettings?.configured ? (
              <>
                <CheckCircledIcon className="h-4 w-4 text-green-400" />
                <span className="text-green-400">
                  Email delivery configured
                </span>
              </>
            ) : (
              <>
                <CrossCircledIcon className="h-4 w-4 text-gray-8" />
                <span className="text-gray-11">
                  Email delivery not configured
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminSettingsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [showWalletModal, setShowWalletModal] = useState(false);

  const {
    data: settings,
    isLoading,
    mutate: mutateSettings,
  } = useSWR<AdminSettings>("/api/admin/settings", api.get);

  const {
    data: balances,
    isLoading: balancesLoading,
    mutate: mutateBalances,
  } = useSWR<WalletBalances>(
    settings?.hasWallet ? "/api/admin/settings/balances" : null,
    api.get,
    { refreshInterval: 60000 },
  );

  const {
    data: emailSettings,
    isLoading: emailLoading,
    mutate: mutateEmail,
  } = useSWR<EmailSettings>("/api/admin/settings/email", api.get);

  const handleSaveWallet = async (config: EcosystemConfig) => {
    setIsSaving(true);
    try {
      const walletConfig = await buildWalletConfig(config);
      await api.put("/api/admin/settings", { wallet_config: walletConfig });
      await mutateSettings();
      await mutateBalances();
      setShowWalletModal(false);
      toast({
        title: "Wallet configured",
        description: "Master wallet has been set up successfully.",
        variant: "success",
      });
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to save wallet",
        variant: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveMinSol = async (amount: number) => {
    setIsSaving(true);
    try {
      await api.put("/api/admin/settings", {
        minimum_balance_sol: amount,
      });
      await mutateSettings();
      toast({
        title: "Minimum SOL updated",
        description: `Minimum SOL balance set to ${amount} SOL`,
        variant: "success",
      });
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to update minimum SOL",
        variant: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveMinUsdc = async (amount: number) => {
    setIsSaving(true);
    try {
      await api.put("/api/admin/settings", { minimum_balance_usdc: amount });
      await mutateSettings();
      toast({
        title: "Minimum USDC updated",
        description: `Minimum USDC balance set to ${amount} USDC`,
        variant: "success",
      });
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to update minimum USDC",
        variant: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveEmailSettings = async (data: {
    from_email?: string;
    site_url?: string;
    template_ids?: {
      verification?: number;
      welcome?: number;
      invitation?: number;
      password_reset?: number;
    };
  }) => {
    setIsSaving(true);
    try {
      await api.put("/api/admin/settings/email", data);
      await mutateEmail();
      toast({
        title: "Email settings updated",
        description: "Email configuration has been saved.",
        variant: "success",
      });
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to update email settings",
        variant: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-12">
          Platform Settings
        </h1>
        <p className="text-sm text-gray-11">
          Configure master wallet and fee percentage
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
        </div>
      ) : settings ? (
        <div className="space-y-6">
          {/* Account Info */}
          <section className="rounded-lg border border-gray-6 bg-gray-2 p-6">
            <h2 className="mb-4 text-lg font-medium text-gray-12">
              Account Information
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-11">Email</label>
                <p className="mt-1 text-gray-12">{user?.email}</p>
              </div>
              <div>
                <label className="block text-sm text-gray-11">Role</label>
                <span className="mt-1 inline-flex rounded-full border border-amber-800 bg-amber-900/50 px-2 py-0.5 text-xs text-amber-400">
                  Administrator
                </span>
              </div>
            </div>
          </section>

          {/* Minimum Balance Settings */}
          <section>
            <div className="grid gap-4 sm:grid-cols-2">
              <FundingAmountEditor
                label="Minimum SOL Balance"
                description="Minimum SOL required in wallet to create proxies."
                currentAmount={settings.minimumBalanceSol}
                unit="SOL"
                min={0.001}
                max={1}
                step={0.001}
                onSave={handleSaveMinSol}
                isSaving={isSaving}
              />
              <FundingAmountEditor
                label="Minimum USDC Balance"
                description="Minimum USDC required in wallet to create proxies."
                currentAmount={settings.minimumBalanceUsdc}
                unit="USDC"
                min={0.001}
                max={100}
                step={0.01}
                onSave={handleSaveMinUsdc}
                isSaving={isSaving}
              />
            </div>
          </section>

          {/* Master Wallet */}
          <section className="rounded-lg border border-gray-6 bg-gray-3 p-6">
            <MasterWalletDisplay
              settings={settings}
              balances={balances}
              balancesLoading={balancesLoading}
              mutateBalances={mutateBalances}
              onConfigureWallet={() => setShowWalletModal(true)}
            />
          </section>

          {/* Email Settings */}
          <section className="rounded-lg border border-gray-6 bg-gray-3 p-6">
            <EmailSettingsSection
              emailSettings={emailSettings}
              isLoading={emailLoading}
              onSave={handleSaveEmailSettings}
              isSaving={isSaving}
            />
          </section>
        </div>
      ) : (
        <div className="rounded-lg border border-gray-6 bg-gray-2 p-6 text-center">
          <p className="text-sm text-red-400">
            Failed to load settings. Please try again.
          </p>
        </div>
      )}

      <WalletSetupModal
        open={showWalletModal}
        onOpenChange={setShowWalletModal}
        onSave={(config) => void handleSaveWallet(config)}
        isSaving={isSaving}
      />
    </div>
  );
}
