"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import {
  CheckIcon,
  ChevronDownIcon,
  Cross2Icon,
  MinusIcon,
  PlusIcon,
} from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";
import { SCHEME_OPTIONS } from "@/lib/types/api";
import { TagsInput } from "@/components/shared/tags-input";
import { TokenPricesSection } from "@/components/shared/token-prices-section";
import { PricingRulesForm, type PricingRule } from "./pricing-rules-form";

type Endpoint = {
  id: number;
  tenant_id: number;
  path: string | null;
  path_pattern: string;
  price: number | null;
  scheme: string | null;
  description: string | null;
  priority: number;
  openapi_source_paths: string[] | null;
  is_active: boolean;
  tags: string[];
  created_at: string;
};

type EndpointEditDialogProps = {
  endpoint: Endpoint;
  tenantId: number;
  defaultScheme: string;
  updateEndpointApiPath: string;
  initialScheme?: string;
  defaultPrice?: number;
  inheritDefaultScheme?: boolean;
  priceStep?: number;
  pricePlaceholder?: string;
  priceUnit?: string;
  showTokenPrices?: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

export function EndpointEditDialog({
  endpoint,
  tenantId,
  defaultScheme,
  updateEndpointApiPath,
  initialScheme,
  defaultPrice,
  inheritDefaultScheme = true,
  priceStep = 0.01,
  pricePlaceholder = "0.01",
  priceUnit = "USD",
  showTokenPrices = false,
  onClose,
  onSuccess,
}: EndpointEditDialogProps) {
  const initialPrice =
    endpoint.price !== null
      ? (endpoint.price / 1_000_000).toString()
      : defaultPrice !== undefined
        ? (defaultPrice / 1_000_000).toString()
        : "";
  const initialSchemeValue = inheritDefaultScheme
    ? (initialScheme ?? endpoint.scheme ?? "")
    : (initialScheme ?? endpoint.scheme ?? defaultScheme);

  const [path, setPath] = useState(endpoint.path ?? endpoint.path_pattern);
  const [price, setPrice] = useState(initialPrice);
  const [scheme, setScheme] = useState(initialSchemeValue);
  const [description, setDescription] = useState(endpoint.description ?? "");
  const [priority, setPriority] = useState(endpoint.priority.toString());
  const [tags, setTags] = useState<string[]>(endpoint.tags ?? []);
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([]);
  const [pricingRulesDirty, setPricingRulesDirty] = useState(false);
  const [pricingRulesValid, setPricingRulesValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const effectiveScheme = inheritDefaultScheme
    ? scheme || defaultScheme
    : scheme;
  const dynamicPricingRulesActive = effectiveScheme === "flex";
  const endpointInitialScheme = endpoint.scheme ?? defaultScheme;
  const switchingToFlex =
    endpointInitialScheme !== "flex" && dynamicPricingRulesActive;
  const hasOpenApiLineage =
    !!endpoint.openapi_source_paths && endpoint.openapi_source_paths.length > 0;

  const adjustPrice = (delta: number) => {
    const next = Math.max(0, parseFloat(price || "0") + delta);
    setPrice(formatPrice(next, delta < 0 && defaultPrice === undefined));
  };

  const handleSubmit = async (
    e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    e.preventDefault();

    if (!pricingRulesValid) {
      toast({
        title: "Fix pricing rules before saving the endpoint",
        variant: "error",
      });
      return;
    }
    if (dynamicPricingRulesActive && !hasOpenApiLineage) {
      toast({
        title: "Flex pricing requires an OpenAPI-backed endpoint",
        variant: "error",
      });
      return;
    }

    const pricePayload = getPricePayload(price, dynamicPricingRulesActive);
    if (pricePayload === undefined) {
      toast({
        title: "Enter a valid endpoint price",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const shouldSavePricingRules =
        dynamicPricingRulesActive &&
        hasOpenApiLineage &&
        (pricingRulesDirty || switchingToFlex) &&
        pricingRules.length > 0;

      await api.put(updateEndpointApiPath, {
        path: path.trim(),
        price: pricePayload,
        scheme: getSchemePayload(scheme, defaultScheme, inheritDefaultScheme),
        description: description.trim() || null,
        priority: parseInt(priority) || 100,
        ...(shouldSavePricingRules && { pricing_rules: pricingRules }),
        tags,
      });

      toast({
        title: "Endpoint updated",
        variant: "default",
      });

      onSuccess();
    } catch {
      toast({
        title: "Failed to update endpoint",
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="scrollbar-none fixed left-1/2 top-1/2 max-h-[90vh] w-[min(920px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-lg">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-gray-12">
              Edit Endpoint
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12">
              <Cross2Icon className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <form
            onSubmit={(e) => void handleSubmit(e)}
            className="mt-4 space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-gray-11">
                Path
              </label>
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 font-mono text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                required
              />
              <p className="mt-1 text-xs text-gray-9">
                example: /api/users or /api/users/{"{id}"}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm text-gray-11">
                  Price
                </label>
                <div className="flex items-center gap-0 rounded-md border border-gray-6 bg-gray-3">
                  <button
                    type="button"
                    onClick={() => adjustPrice(-priceStep)}
                    disabled={dynamicPricingRulesActive}
                    className="flex h-9 w-9 items-center justify-center rounded-l-md text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-gray-11"
                  >
                    <MinusIcon className="h-4 w-4" />
                  </button>
                  <div className="flex flex-1 items-center">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={price}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === "" || /^\d*\.?\d*$/.test(value)) {
                          setPrice(value);
                        }
                      }}
                      placeholder={pricePlaceholder}
                      disabled={dynamicPricingRulesActive}
                      className="w-full bg-transparent py-2 text-center text-sm text-gray-12 placeholder-gray-9 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <span className="pr-2 text-xs text-gray-11">
                      {priceUnit}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => adjustPrice(priceStep)}
                    disabled={dynamicPricingRulesActive}
                    className="flex h-9 w-9 items-center justify-center rounded-r-md text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-gray-11"
                  >
                    <PlusIcon className="h-4 w-4" />
                  </button>
                </div>
                {dynamicPricingRulesActive && (
                  <p className="mt-1 text-xs text-gray-11">
                    Flex endpoints use the pricing rules below.
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1.5 block text-sm text-gray-11">
                  Scheme
                </label>
                <Select.Root
                  value={effectiveScheme}
                  onValueChange={(value) =>
                    setScheme(
                      inheritDefaultScheme && value === defaultScheme
                        ? ""
                        : value,
                    )
                  }
                >
                  <Select.Trigger className="flex h-9 w-full items-center justify-between rounded-md border border-gray-6 bg-gray-3 px-3 text-sm text-gray-12 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8">
                    <Select.Value />
                    <Select.Icon>
                      <ChevronDownIcon className="h-3.5 w-3.5 text-gray-11" />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content
                      className="overflow-hidden rounded border border-gray-6 bg-gray-2 shadow-lg"
                      position="popper"
                      sideOffset={4}
                    >
                      <Select.Viewport className="p-1">
                        {SCHEME_OPTIONS.map((opt) => (
                          <Select.Item
                            key={opt.value}
                            value={opt.value}
                            disabled={opt.disabled}
                            className="relative flex cursor-pointer select-none items-center rounded px-6 py-1.5 text-sm outline-none hover:bg-gray-4 data-[disabled]:cursor-not-allowed data-[disabled]:text-gray-8 data-[disabled]:hover:bg-transparent data-[highlighted]:bg-gray-4"
                          >
                            <Select.ItemIndicator className="absolute left-1 inline-flex items-center">
                              <CheckIcon className="h-3 w-3 text-accent-11" />
                            </Select.ItemIndicator>
                            <Select.ItemText>{opt.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>
            </div>

            {showTokenPrices && (
              <TokenPricesSection
                tenantId={tenantId}
                endpointId={endpoint.id}
              />
            )}

            <PricingRulesForm
              tenantId={tenantId}
              endpointId={endpoint.id}
              scheme={effectiveScheme}
              hasOpenApiLineage={hasOpenApiLineage}
              onRulesChange={setPricingRules}
              onDirtyChange={setPricingRulesDirty}
              onValidChange={setPricingRulesValid}
              showSaveButton={false}
            />

            <div>
              <label className="block text-sm font-medium text-gray-11">
                Priority
              </label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                min="1"
                className="mt-1 w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
              />
              <p className="mt-0.5 text-xs text-gray-11">
                Lower numbers are evaluated first
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-11">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description"
                className="mt-1 w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-11">
                Tags
              </label>
              <div className="mt-1">
                <TagsInput tags={tags} onChange={setTags} />
              </div>
            </div>

            {endpoint.openapi_source_paths &&
              endpoint.openapi_source_paths.length > 0 && (
                <div className="rounded-md border border-gray-6 bg-gray-3 p-3">
                  <p className="mb-1 text-xs font-medium text-gray-11">
                    OpenAPI Source Paths:
                  </p>
                  <ul className="space-y-0.5">
                    {endpoint.openapi_source_paths.map((sourcePath, index) => (
                      <li
                        key={`${sourcePath}-${index}`}
                        className="font-mono text-xs text-gray-12"
                      >
                        {sourcePath}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-2 text-sm font-medium text-gray-11 hover:bg-gray-4 hover:text-gray-12"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || !pricingRulesValid}
                className="rounded-md bg-white px-3 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function formatPrice(value: number, emptyWhenZero: boolean): string {
  if (value === 0 && emptyWhenZero) {
    return "";
  }
  return value.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function getPricePayload(
  price: string,
  dynamicPricingRulesActive: boolean,
): number | null | undefined {
  if (dynamicPricingRulesActive) {
    return null;
  }

  const trimmed = price.trim();
  if (trimmed === "") {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return Math.round(parsed * 1_000_000);
}

function getSchemePayload(
  scheme: string,
  defaultScheme: string,
  inheritDefaultScheme: boolean,
): string | null {
  if (inheritDefaultScheme && scheme === defaultScheme) {
    return null;
  }
  return scheme || null;
}
