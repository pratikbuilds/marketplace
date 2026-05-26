"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ChevronDownIcon,
  CheckIcon,
  MagnifyingGlassIcon,
} from "@radix-ui/react-icons";
import useSWR from "swr";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";

const PAGE_SIZE = 10;

interface Wallet {
  id: number;
  name: string;
  organization_id: number | null;
  organization_name: string | null;
  funding_status: string;
}

interface InlineWalletSelectProps {
  tenantId: number;
  tenantName: string;
  tenantOrgId: number | null;
  currentWalletId: number | null;
  currentWalletName: string | null;
  onUpdate: () => void;
}

export function InlineWalletSelect({
  tenantId,
  tenantName,
  tenantOrgId,
  currentWalletId,
  currentWalletName,
  onUpdate,
}: InlineWalletSelectProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const searchRef = useRef<HTMLInputElement>(null);

  const { data: masterWallets } = useSWR(
    isOpen ? "/api/wallets/admin/master" : null,
    api.get<Wallet[]>,
  );

  const { data: orgWallets } = useSWR(
    isOpen && tenantOrgId ? `/api/wallets/organization/${tenantOrgId}` : null,
    api.get<Wallet[]>,
  );

  const availableWallets = useMemo(
    () => [...(masterWallets ?? []), ...(orgWallets ?? [])],
    [masterWallets, orgWallets],
  );

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setVisibleCount(PAGE_SIZE);
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const filtered = useMemo(() => {
    if (!search.trim()) return availableWallets;
    const q = search.toLowerCase();
    return availableWallets.filter((w) => w.name.toLowerCase().includes(q));
  }, [availableWallets, search]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;

  const handleChange = async (newWalletId: number | null) => {
    if (newWalletId === currentWalletId) {
      setIsOpen(false);
      return;
    }

    setIsSaving(true);
    try {
      await api.put(`/api/admin/tenants/${tenantId}`, {
        wallet_id: newWalletId,
      });
      toast({
        title: "Wallet updated",
        description: `${tenantName} has been updated.`,
        variant: "success",
      });
      onUpdate();
    } catch (err) {
      toast({
        title: "Failed to update",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setIsSaving(false);
      setIsOpen(false);
    }
  };

  const getStatusColor = () => {
    if (isSaving) return "opacity-50 border-gray-6 bg-gray-3 text-gray-11";
    if (!currentWalletId)
      return "border-red-700 bg-red-900/30 text-red-400 hover:bg-red-900/40";
    return "border-accent-7 bg-accent-3 text-accent-11 hover:bg-accent-4";
  };

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger asChild>
        <button
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors focus:outline-none focus:ring-1 focus:ring-accent-8 ${getStatusColor()}`}
          disabled={isSaving}
        >
          {isSaving ? "Saving..." : (currentWalletName ?? "No wallet")}
          <ChevronDownIcon className="h-3 w-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="w-72 rounded-lg border border-gray-6 bg-gray-2 p-2 shadow-lg"
          sideOffset={4}
          align="start"
        >
          <div className="relative mb-2">
            <MagnifyingGlassIcon className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-9" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              placeholder="Search wallets..."
              className="w-full rounded border border-gray-6 bg-gray-3 py-1.5 pl-7 pr-2 text-sm text-gray-12 placeholder:text-gray-9 focus:border-accent-8 focus:outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            <button
              onClick={() => void handleChange(null)}
              className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-sm transition-colors ${
                currentWalletId === null
                  ? "bg-accent-3 text-accent-11"
                  : "text-gray-11 hover:bg-gray-4 hover:text-gray-12"
              }`}
            >
              <span>No wallet</span>
              {currentWalletId === null && <CheckIcon className="h-4 w-4" />}
            </button>
            {visible.map((wallet) => {
              const isMaster = wallet.organization_id === null;
              const isUnfunded = wallet.funding_status !== "funded";
              const isSelected = currentWalletId === wallet.id;

              return (
                <button
                  key={wallet.id}
                  onClick={() => {
                    if (!isUnfunded) void handleChange(wallet.id);
                  }}
                  disabled={isUnfunded}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-sm transition-colors ${
                    isSelected
                      ? "bg-accent-3 text-accent-11"
                      : isUnfunded
                        ? "opacity-50 cursor-not-allowed text-gray-11"
                        : "text-gray-11 hover:bg-gray-4 hover:text-gray-12"
                  }`}
                >
                  <span className={isMaster ? "text-purple-400" : ""}>
                    {wallet.name}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {isMaster && (
                      <span className="rounded-full border border-purple-800 bg-purple-900/30 px-1.5 py-0.5 text-xs text-purple-400">
                        master
                      </span>
                    )}
                    {isUnfunded && (
                      <span className="rounded-full border border-yellow-800 bg-yellow-900/30 px-1.5 py-0.5 text-xs text-yellow-400">
                        unfunded
                      </span>
                    )}
                    {isSelected && <CheckIcon className="h-4 w-4" />}
                  </div>
                </button>
              );
            })}
            {hasMore && (
              <button
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className="w-full rounded px-2 py-1.5 text-center text-xs text-gray-9 hover:bg-gray-4 hover:text-gray-11"
              >
                Show more ({filtered.length - visibleCount} remaining)
              </button>
            )}
            {filtered.length === 0 && availableWallets.length > 0 && (
              <p className="py-2 text-center text-xs text-gray-9">No matches</p>
            )}
          </div>
          <Popover.Arrow className="fill-gray-6" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
