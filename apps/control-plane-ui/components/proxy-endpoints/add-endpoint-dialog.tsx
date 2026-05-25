"use client";

import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Cross2Icon,
  PlusIcon,
  MinusIcon,
  ChevronDownIcon,
  CheckIcon,
} from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";
import { DEFAULT_SCHEME, SCHEME_OPTIONS } from "@/lib/types/api";
import { TagsInput } from "@/components/shared/tags-input";
import { useAuth } from "@/lib/auth/context";
import { refreshOnboardingStatus } from "@/lib/hooks/use-onboarding";
import { PricingRulesForm, type PricingRule } from "./pricing-rules-form";

interface AddEndpointDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: number;
  hasOpenApiSpec: boolean;
  onSuccess: () => void;
  defaultPrice: number;
  defaultScheme: string;
}

interface ValidatePatternResponse {
  valid: boolean;
  isValidRegex: boolean;
  matches: string[];
  hasSpec?: boolean;
  error?: string;
}

export function AddEndpointDialog({
  open,
  onOpenChange,
  tenantId,
  hasOpenApiSpec,
  onSuccess,
  defaultPrice,
  defaultScheme,
}: AddEndpointDialogProps) {
  const [pathPattern, setPathPattern] = useState("");
  const [price, setPrice] = useState("");
  const [scheme, setScheme] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidatePatternResponse | null>(
    null,
  );
  const [tags, setTags] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([]);
  const [pricingRulesDirty, setPricingRulesDirty] = useState(false);
  const [pricingRulesValid, setPricingRulesValid] = useState(true);
  const { toast } = useToast();
  const { currentOrg } = useAuth();
  const effectiveScheme = scheme || defaultScheme || DEFAULT_SCHEME;
  const dynamicPricingRulesActive = effectiveScheme === "flex";
  const disabledPriceTooltip =
    "Flex endpoints use dynamic pricing rules below, so this fixed fallback price is not used.";

  useEffect(() => {
    setSelectedPaths([]);
    setPricingRulesDirty(false);
    setPricingRulesValid(true);

    if (!pathPattern.trim()) {
      setValidation(null);
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        const catchAllPatterns = ["/", "/*", "^/$", "^/.*$"];
        if (catchAllPatterns.includes(pathPattern)) {
          setValidation({
            valid: false,
            isValidRegex: false,
            matches: [],
            error: "Edit the catch-all row in the table to set pricing for /",
          });
          return;
        }

        // Only validate as regex if it starts with ^
        // Otherwise it's either OpenAPI-style ({param}) or literal prefix
        if (pathPattern.startsWith("^")) {
          try {
            new RegExp(pathPattern);
            setValidation({
              valid: true,
              isValidRegex: true,
              matches: [],
              hasSpec: false,
            });
          } catch {
            setValidation({
              valid: false,
              isValidRegex: false,
              matches: [],
              error: "Invalid regex pattern",
            });
          }
        } else {
          // Non-regex patterns are always valid
          setValidation({
            valid: true,
            isValidRegex: true,
            matches: [],
            hasSpec: false,
          });
        }

        // If we have an OpenAPI spec, also check for matches
        if (hasOpenApiSpec) {
          setValidating(true);
          try {
            const result = await api.post<ValidatePatternResponse>(
              `/api/tenants/${tenantId}/openapi/validate-pattern`,
              { pattern: pathPattern },
            );
            setSelectedPaths(result.matches);
            setValidation((prev) =>
              prev ? { ...prev, matches: result.matches } : null,
            );
          } catch {
            // Ignore validation errors for OpenAPI matching
          } finally {
            setValidating(false);
          }
        }
      })();
    }, 300);

    return () => clearTimeout(timer);
  }, [pathPattern, tenantId, hasOpenApiSpec]);

  const handleSubmit = async (
    e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    e.preventDefault();

    if (!pathPattern.trim()) return;
    if (!validation?.isValidRegex) return;
    if (!pricingRulesValid) {
      toast({
        title: "Fix pricing rules before creating the endpoint",
        variant: "error",
      });
      return;
    }
    if (dynamicPricingRulesActive && selectedPaths.length === 0) {
      toast({
        title: "Flex pricing requires an OpenAPI-backed endpoint",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      await api.post(`/api/tenants/${tenantId}/endpoints`, {
        path: pathPattern.trim(),
        price:
          !dynamicPricingRulesActive && price
            ? Math.round(parseFloat(price) * 1000000)
            : null,
        scheme: scheme || null,
        description: description.trim() || null,
        openapi_source_paths: selectedPaths.length > 0 ? selectedPaths : null,
        ...(effectiveScheme === "flex" &&
          pricingRulesDirty &&
          selectedPaths.length > 0 &&
          pricingRules.length > 0 && { pricing_rules: pricingRules }),
        tags: tags.length > 0 ? tags : [],
      });

      toast({
        title: "Endpoint created",
        variant: "default",
      });

      if (currentOrg) {
        refreshOnboardingStatus(currentOrg.id);
      }

      setPathPattern("");
      setPrice("");
      setScheme("");
      setDescription("");
      setTags([]);
      setPricingRules([]);
      setPricingRulesDirty(false);
      setPricingRulesValid(true);
      setValidation(null);
      setSelectedPaths([]);
      onSuccess();
      onOpenChange(false);
    } catch {
      toast({
        title: "Failed to create endpoint",
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const togglePath = (path: string) => {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="scrollbar-none fixed left-1/2 top-1/2 max-h-[90vh] w-[min(920px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-lg">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-gray-12">
              Add Endpoint
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
                Path <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={pathPattern}
                onChange={(e) => setPathPattern(e.target.value)}
                placeholder="/api/users/{id}"
                className="mt-1 w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 font-mono placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                required
              />
              <p className="mt-1 text-xs text-gray-9">
                example: /api/users or /api/users/{"{id}"}
              </p>
              {validating && (
                <p className="mt-1 text-xs text-gray-11">Validating...</p>
              )}
              {validation?.error && (
                <p className="mt-1 text-xs text-red-400">{validation.error}</p>
              )}
            </div>

            {validation?.isValidRegex && hasOpenApiSpec && (
              <div>
                {validation.matches.length > 0 ? (
                  <div className="rounded-md border border-gray-6 bg-gray-3 p-3">
                    <p className="mb-2 text-xs font-medium text-gray-11">
                      Matches from OpenAPI spec:
                    </p>
                    <div className="max-h-32 space-y-1 overflow-y-auto">
                      {validation.matches.map((path) => (
                        <label
                          key={path}
                          className="flex items-center gap-2 text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={selectedPaths.includes(path)}
                            onChange={() => togglePath(path)}
                            className="rounded border-gray-6"
                          />
                          <code className="text-gray-12">{path}</code>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm text-gray-11">
                  Price
                </label>
                <Tooltip.Provider delayDuration={150}>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <div
                        tabIndex={dynamicPricingRulesActive ? 0 : undefined}
                        className="flex items-center gap-0 rounded-md border border-gray-6 bg-gray-3"
                      >
                        <button
                          type="button"
                          disabled={dynamicPricingRulesActive}
                          onClick={() => {
                            const val = Math.max(
                              0,
                              parseFloat(price || "0") - 0.01,
                            );
                            setPrice(val.toFixed(3));
                          }}
                          className="flex h-9 w-9 items-center justify-center text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors rounded-l-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-gray-11"
                        >
                          <MinusIcon className="h-4 w-4" />
                        </button>
                        <div className="flex flex-1 items-center">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={price}
                            disabled={dynamicPricingRulesActive}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val === "" || /^\d*\.?\d*$/.test(val)) {
                                setPrice(val);
                              }
                            }}
                            placeholder={(defaultPrice / 1_000_000).toFixed(3)}
                            className="w-full bg-transparent py-2 text-center text-sm text-gray-12 placeholder-gray-9 focus:outline-none disabled:cursor-not-allowed disabled:text-gray-9"
                          />
                          <span className="pr-2 text-xs text-gray-11">USD</span>
                        </div>
                        <button
                          type="button"
                          disabled={dynamicPricingRulesActive}
                          onClick={() => {
                            const val = parseFloat(price || "0") + 0.01;
                            setPrice(val.toFixed(3));
                          }}
                          className="flex h-9 w-9 items-center justify-center text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors rounded-r-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-gray-11"
                        >
                          <PlusIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </Tooltip.Trigger>
                    {dynamicPricingRulesActive && (
                      <Tooltip.Portal>
                        <Tooltip.Content
                          side="top"
                          align="start"
                          className="z-[70] max-w-xs rounded-md border border-gray-6 bg-gray-1 px-3 py-2 text-xs leading-5 text-gray-12 shadow-lg"
                        >
                          {disabledPriceTooltip}
                          <Tooltip.Arrow className="fill-gray-1" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    )}
                  </Tooltip.Root>
                </Tooltip.Provider>
              </div>
              <div>
                <label className="mb-1.5 block text-sm text-gray-11">
                  Scheme
                </label>
                <Select.Root
                  value={effectiveScheme}
                  onValueChange={(value) =>
                    setScheme(value === defaultScheme ? "" : value)
                  }
                >
                  <Select.Trigger className="flex w-full h-9 items-center justify-between rounded-md border border-gray-6 bg-gray-3 px-3 text-sm text-gray-12 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8">
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
                            className="relative flex cursor-pointer select-none items-center rounded px-6 py-1.5 text-sm outline-none hover:bg-gray-4 data-[highlighted]:bg-gray-4 data-[disabled]:text-gray-8 data-[disabled]:cursor-not-allowed data-[disabled]:hover:bg-transparent"
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

            <PricingRulesForm
              tenantId={tenantId}
              scheme={effectiveScheme}
              hasOpenApiLineage
              onRulesChange={setPricingRules}
              onDirtyChange={setPricingRulesDirty}
              onValidChange={setPricingRulesValid}
              showSaveButton={false}
            />

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

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-md px-3 py-2 text-sm font-medium text-gray-11 hover:bg-gray-4 hover:text-gray-12"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || !validation?.isValidRegex}
                className="rounded-md bg-white px-3 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90 disabled:opacity-50"
              >
                {saving ? "Creating..." : "Add Endpoint"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
