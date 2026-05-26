"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import {
  Cross2Icon,
  PlusIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";
import { type TokenPrice, type SupportedToken } from "@/lib/types/api";

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

  const fetchPrices = useCallback(async () => {
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
  }, [endpointId, tenantId]);

  const { data: supportedTokensData } = useSWR<{
    data: SupportedToken[];
  }>("/api/token-rates/supported-tokens", api.get);
  const supportedTokens = supportedTokensData?.data ?? [];

  // Fetch on mount to show count in collapsed state
  useEffect(() => {
    if (!initialLoaded) {
      void fetchPrices();
    }
  }, [fetchPrices, initialLoaded]);

  useEffect(() => {
    if (expanded && initialLoaded) {
      void fetchPrices();
    }
  }, [expanded, fetchPrices, initialLoaded]);

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
  onDelete,
}: {
  tokenPrice: TokenPrice;
  onSave: (newAmount: string) => void;
  onDelete: () => void;
}) {
  const displayAmount = (Number(tokenPrice.amount) / 1_000_000).toString();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayAmount);

  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-xs font-medium text-gray-12">
        {tokenPrice.token_symbol}
      </span>
      <span className="text-[10px] text-gray-9 truncate w-20">
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
          className="flex-1 rounded border border-gray-6 bg-gray-2 px-2 py-1 text-xs text-gray-12 focus:outline-none focus:border-accent-8"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setValue(displayAmount);
            setEditing(true);
          }}
          className="flex-1 text-left text-xs text-gray-11 hover:text-gray-12 cursor-pointer"
        >
          ${displayAmount}
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="p-0.5 text-gray-9 hover:text-red-400"
        title="Remove token"
      >
        <Cross2Icon className="h-3 w-3" />
      </button>
    </div>
  );
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
