"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import {
  Cross2Icon,
  PlusIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";
import {
  type PayoutSplit,
  type TokenPrice,
  type SupportedToken,
} from "@/lib/types/api";

interface TokenPricesSectionProps {
  tenantId: number;
  endpointId?: number | null;
  onUpdated?: () => void;
}

export function TokenPricesSection({
  tenantId,
  endpointId,
  onUpdated,
}: TokenPricesSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [prices, setPrices] = useState<TokenPrice[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const { toast } = useToast();

  const fetchPrices = async () => {
    setLoading(true);
    try {
      const query = endpointId ? `?endpoint_id=${endpointId}` : "";
      const res = await api.get<{ data: TokenPrice[] }>(
        `/api/tenants/${tenantId}/token-prices${query}`,
      );
      setPrices(res.data ?? []);
    } catch {
      // Silently fail - prices may not exist yet
    } finally {
      setLoading(false);
      setInitialLoaded(true);
    }
  };

  const { data: supportedTokensData } = useSWR<{
    data: SupportedToken[];
  }>("/api/token-rates/supported-tokens", api.get);
  const supportedTokens = supportedTokensData?.data ?? [];

  // Fetch on mount to show count in collapsed state
  useEffect(() => {
    if (!initialLoaded) {
      void fetchPrices();
    }
  }, [tenantId, endpointId]);

  useEffect(() => {
    if (expanded && initialLoaded) {
      void fetchPrices();
    }
  }, [expanded, tenantId, endpointId]);

  const handleUpdateAmount = async (tp: TokenPrice, newAmount: string) => {
    const microAmount = Math.round(parseFloat(newAmount) * 1_000_000);
    if (isNaN(microAmount) || microAmount < 0) return;

    try {
      await api.put(`/api/tenants/${tenantId}/token-prices/${tp.id}`, {
        amount: microAmount,
      });
      toast({ title: `${tp.token_symbol} price updated`, variant: "default" });
      void fetchPrices();
      onUpdated?.();
    } catch {
      toast({ title: "Failed to update price", variant: "error" });
    }
  };

  const handleDelete = async (tp: TokenPrice) => {
    try {
      await api.delete(`/api/tenants/${tenantId}/token-prices/${tp.id}`);
      toast({ title: `${tp.token_symbol} removed`, variant: "default" });
      void fetchPrices();
      onUpdated?.();
    } catch {
      toast({ title: "Failed to remove token", variant: "error" });
    }
  };

  const handleUpdateSplits = async (
    tp: TokenPrice,
    payoutSplits: PayoutSplit[] | null,
  ) => {
    try {
      await api.put(`/api/tenants/${tenantId}/token-prices/${tp.id}`, {
        payout_splits: payoutSplits,
      });
      toast({ title: `${tp.token_symbol} payout updated`, variant: "default" });
      void fetchPrices();
      onUpdated?.();
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : "Failed to update payout",
        variant: "error",
      });
    }
  };

  const handleAdd = async (token: SupportedToken) => {
    try {
      await api.post(`/api/tenants/${tenantId}/token-prices`, {
        token_symbol: token.symbol,
        mint_address: token.mint,
        network: token.network,
        amount: 0,
        decimals: token.decimals ?? 6,
        endpoint_id: endpointId ?? null,
      });
      toast({ title: `${token.symbol} added`, variant: "default" });
      void fetchPrices();
      onUpdated?.();
    } catch {
      toast({ title: "Failed to add token", variant: "error" });
    }
  };

  const existingKeys = new Set(
    prices.map((p) => `${p.token_symbol}:${p.network}`),
  );
  const availableTokens = supportedTokens.filter(
    (t) => !existingKeys.has(`${t.symbol}:${t.network}`),
  );

  return (
    <div className="rounded-md border border-gray-6 bg-gray-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs text-gray-11 hover:text-gray-12"
      >
        <span className="flex items-center gap-2">
          Advanced Token Pricing
          {!expanded && prices.length > 0 && (
            <span className="rounded-full bg-amber-900/30 border border-amber-700 px-1.5 text-[9px] text-amber-400">
              {prices.length} configured
            </span>
          )}
        </span>
        {expanded ? (
          <ChevronDownIcon className="h-3.5 w-3.5" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-6 px-3 py-2 space-y-2">
          {loading ? (
            <p className="text-xs text-gray-9">Loading...</p>
          ) : prices.length === 0 ? (
            <p className="text-xs text-gray-9">
              No per-token prices configured. USD-pegged tokens use the default
              price.
            </p>
          ) : (
            <div className="space-y-1.5">
              {prices.map((tp) => (
                <TokenPriceRow
                  key={tp.id}
                  tokenPrice={tp}
                  onSave={(newAmount) => void handleUpdateAmount(tp, newAmount)}
                  onSaveSplits={(payoutSplits) =>
                    void handleUpdateSplits(tp, payoutSplits)
                  }
                  onDelete={() => void handleDelete(tp)}
                />
              ))}
            </div>
          )}

          {availableTokens.length > 0 && (
            <div className="pt-1 border-t border-gray-6">
              <AddTokenDropdown
                tokens={availableTokens}
                onAdd={(token) => void handleAdd(token)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TokenPriceRow({
  tokenPrice,
  onSave,
  onSaveSplits,
  onDelete,
}: {
  tokenPrice: TokenPrice;
  onSave: (newAmount: string) => void;
  onSaveSplits: (payoutSplits: PayoutSplit[] | null) => void;
  onDelete: () => void;
}) {
  const displayAmount = (Number(tokenPrice.amount) / 1_000_000).toString();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayAmount);
  const [splitsOpen, setSplitsOpen] = useState(false);
  const [splits, setSplits] = useState<PayoutSplit[]>(
    tokenPrice.payout_splits ?? [],
  );
  const totalBps = splits.reduce((sum, split) => sum + split.bps, 0);
  const splitError = validatePayoutSplits(splits);

  useEffect(() => {
    setSplits(tokenPrice.payout_splits ?? []);
  }, [tokenPrice.payout_splits]);

  function updateSplit(index: number, patch: Partial<PayoutSplit>) {
    setSplits((current) =>
      current.map((split, i) => (i === index ? { ...split, ...patch } : split)),
    );
  }

  return (
    <div className="rounded border border-gray-6 bg-gray-2">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="w-16 text-xs font-medium text-gray-12">
          {tokenPrice.token_symbol}
        </span>
        <span className="w-20 truncate text-[10px] text-gray-9">
          {tokenPrice.network}
        </span>
        {editing ? (
          <input
            type="text"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => {
              onSave(value);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onSave(value);
                setEditing(false);
              }
            }}
            autoFocus
            className="flex-1 rounded border border-gray-6 bg-gray-2 px-2 py-1 text-xs text-gray-12 focus:border-accent-8 focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setValue(displayAmount);
              setEditing(true);
            }}
            className="flex-1 cursor-pointer text-left text-xs text-gray-11 hover:text-gray-12"
          >
            ${displayAmount}
          </button>
        )}
        <button
          type="button"
          onClick={() => setSplitsOpen((open) => !open)}
          className="text-[10px] text-accent-11 hover:text-accent-12"
        >
          {tokenPrice.payout_splits ? "Splits" : "Single"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="p-0.5 text-gray-9 hover:text-red-400"
          title="Remove token"
        >
          <Cross2Icon className="h-3 w-3" />
        </button>
      </div>

      {splitsOpen && (
        <div className="space-y-2 border-t border-gray-6 p-2">
          {splits.length === 0 ? (
            <p className="text-[10px] leading-4 text-gray-9">
              This token pays to the configured wallet address.
            </p>
          ) : (
            <div className="space-y-1.5">
              {splits.map((split, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[minmax(0,1fr)_72px_20px] gap-1.5"
                >
                  <input
                    type="text"
                    value={split.recipient}
                    onChange={(e) =>
                      updateSplit(index, { recipient: e.target.value })
                    }
                    placeholder="Recipient address"
                    className="h-8 min-w-0 rounded border border-gray-6 bg-gray-3 px-2 font-mono text-[11px] text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none"
                  />
                  <input
                    type="number"
                    value={split.bps}
                    onChange={(e) =>
                      updateSplit(index, { bps: Number(e.target.value) })
                    }
                    className="h-8 rounded border border-gray-6 bg-gray-3 px-2 text-xs text-gray-12 focus:border-accent-8 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setSplits((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                    className="flex h-8 items-center justify-center text-gray-9 hover:text-red-400"
                    title="Remove split"
                  >
                    <Cross2Icon className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span
              className={`text-[10px] ${
                splitError ? "text-red-300" : "text-gray-9"
              }`}
            >
              {splits.length === 0 ? "10000 bps default" : `${totalBps} bps`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setSplits((current) =>
                    current.length === 0
                      ? [
                          { recipient: "", bps: 5000 },
                          { recipient: "", bps: 5000 },
                        ]
                      : [...current, { recipient: "", bps: 0 }],
                  )
                }
                className="flex items-center gap-1 text-[10px] text-accent-11 hover:text-accent-12"
              >
                <PlusIcon className="h-3 w-3" />
                Add split
              </button>
              <button
                type="button"
                onClick={() =>
                  onSaveSplits(splits.length === 0 ? null : splits)
                }
                disabled={splitError !== null}
                className="rounded bg-accent-9 px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-10 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
          {splitError && (
            <p className="text-[10px] text-red-300">{splitError}</p>
          )}
        </div>
      )}
    </div>
  );
}

function validatePayoutSplits(splits: PayoutSplit[]): string | null {
  if (splits.length === 0) return null;
  for (const split of splits) {
    if (split.recipient.trim() === "") return "Recipient address required";
    if (!Number.isInteger(split.bps) || split.bps <= 0) {
      return "Bps values must be positive integers";
    }
  }
  const total = splits.reduce((sum, split) => sum + split.bps, 0);
  return total === 10000 ? null : "Bps total must equal 10000";
}

function AddTokenDropdown({
  tokens,
  onAdd,
}: {
  tokens: SupportedToken[];
  onAdd: (token: SupportedToken) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-1 text-xs text-accent-11 hover:text-accent-12"
      >
        <PlusIcon className="h-3 w-3" />
        Add token
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-[10px] text-gray-9">Select token to add:</p>
      <div className="max-h-32 overflow-y-auto space-y-0.5">
        {tokens.map((t) => (
          <button
            key={`${t.symbol}:${t.network}`}
            type="button"
            onClick={() => {
              onAdd(t);
              setIsOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs text-gray-11 hover:bg-gray-4 hover:text-gray-12"
          >
            <span className="font-medium">{t.symbol}</span>
            <span className="text-[10px] text-gray-9">{t.network}</span>
            {!t.isUsdPegged && (
              <span className="text-[10px] text-amber-400">non-USD</span>
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setIsOpen(false)}
        className="text-[10px] text-gray-9 hover:text-gray-11"
      >
        Cancel
      </button>
    </div>
  );
}
