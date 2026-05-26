"use client";

import { useEffect, useMemo, useState } from "react";
import * as Select from "@radix-ui/react-select";
import {
  CheckIcon,
  ChevronDownIcon,
  CaretDownIcon,
  CaretRightIcon,
  CopyIcon,
  PlusIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { api, ApiError } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";
import {
  buildAIPricingRulesPrompt,
  buildRule,
  buildRules,
  buildRulesSummary,
  chargeAmountModes,
  createFriendlyRule,
  createFriendlyRulesFromPricingRules,
  formatRulesJson,
  matchModes,
  parseRulesJson,
  reserveAmountModes,
  validateFriendlyRules,
  type AmountMode,
  type FriendlyRule,
  type MatchMode,
  type PricingRule,
} from "@/lib/pricing-rules";
export type { PricingRule } from "@/lib/pricing-rules";

interface PricingRulesResponse {
  rules: PricingRule[];
  editable: boolean;
  reason?: string;
}

interface PricingRulesFormProps {
  tenantId: number;
  endpointId?: number;
  mode?: "endpoint" | "tenant";
  scheme?: string | null;
  hasOpenApiLineage: boolean;
  onRulesChange?: (rules: PricingRule[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onValidChange?: (valid: boolean) => void;
  onSaveRules?: (rules: PricingRule[]) => void | Promise<void>;
  onSaved?: () => void | Promise<void>;
  showSaveButton?: boolean;
}

export function PricingRulesForm({
  tenantId,
  endpointId,
  mode = "endpoint",
  scheme,
  hasOpenApiLineage,
  onRulesChange,
  onDirtyChange,
  onValidChange,
  onSaveRules,
  onSaved,
  showSaveButton = true,
}: PricingRulesFormProps) {
  const [rules, setRules] = useState<FriendlyRule[]>([createFriendlyRule()]);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [technicalJson, setTechnicalJson] = useState(
    formatRulesJson([buildRule(createFriendlyRule())]),
  );
  const [technicalDirty, setTechnicalDirty] = useState(false);
  const [technicalError, setTechnicalError] = useState<string | null>(null);
  const [editable, setEditable] = useState(hasOpenApiLineage);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const pricingRulesEnabled = scheme === undefined || scheme === "flex";
  const validationError = useMemo(() => validateFriendlyRules(rules), [rules]);
  const generatedRules = useMemo(
    () => (validationError ? [] : buildRules(rules)),
    [rules, validationError],
  );
  const activeError = technicalDirty ? technicalError : validationError;

  useEffect(() => {
    if (!pricingRulesEnabled) {
      onRulesChange?.([]);
      onValidChange?.(true);
      return;
    }

    if (validationError) {
      onValidChange?.(false);
      return;
    }

    if (!technicalDirty) {
      setTechnicalJson(formatRulesJson(generatedRules));
      onRulesChange?.(generatedRules);
      onValidChange?.(true);
    }
  }, [
    generatedRules,
    onRulesChange,
    onValidChange,
    pricingRulesEnabled,
    technicalDirty,
    validationError,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function loadRules() {
      if (!pricingRulesEnabled) {
        setEditable(false);
        setReason("Pricing rules only apply to Flex endpoints.");
        setTechnicalDirty(false);
        onDirtyChange?.(false);
        onValidChange?.(true);
        return;
      }

      if (mode === "endpoint" && !hasOpenApiLineage) {
        setEditable(false);
        setReason("Pricing rules require an OpenAPI-backed endpoint.");
        onDirtyChange?.(false);
        onValidChange?.(true);
        return;
      }

      if (mode === "endpoint" && endpointId === undefined) {
        setEditable(true);
        setReason(null);
        onDirtyChange?.(false);
        onValidChange?.(true);
        return;
      }

      setLoading(true);
      try {
        const rulesEndpoint =
          mode === "tenant"
            ? `/api/tenants/${tenantId}/pricing-rules`
            : `/api/tenants/${tenantId}/endpoints/${endpointId}/pricing-rules`;
        const response = await api.get<PricingRulesResponse>(rulesEndpoint);
        if (cancelled) return;

        setEditable(response.editable);
        setReason(response.reason ?? null);
        onDirtyChange?.(false);
        onValidChange?.(true);
        if (response.rules.length > 0) {
          setRules(createFriendlyRulesFromPricingRules(response.rules));
          setTechnicalJson(formatRulesJson(response.rules));
          setTechnicalDirty(false);
        } else {
          const defaultRules = [buildRule(createFriendlyRule())];
          setRules(createFriendlyRulesFromPricingRules(defaultRules));
          setTechnicalJson(formatRulesJson(defaultRules));
          setTechnicalDirty(false);
        }
      } catch (err) {
        if (cancelled) return;
        setEditable(false);
        setReason(err instanceof Error ? err.message : "Failed to load rules");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadRules();
    return () => {
      cancelled = true;
    };
  }, [
    endpointId,
    hasOpenApiLineage,
    mode,
    onDirtyChange,
    onValidChange,
    pricingRulesEnabled,
    tenantId,
  ]);

  function updateRule(id: string, patch: Partial<FriendlyRule>) {
    setTechnicalDirty(false);
    setTechnicalError(null);
    onDirtyChange?.(true);
    setRules((current) =>
      current.map((rule) => {
        if (rule.id !== id) return rule;
        const { advancedRule: _advancedRule, ...friendlyRule } = rule;
        const chargeTiming =
          friendlyRule.chargeTiming ??
          (friendlyRule.holdUsd.trim() === "" ? "upfront" : "after-response");
        return { ...friendlyRule, chargeTiming, ...patch };
      }),
    );
  }

  function addRule() {
    setTechnicalDirty(false);
    setTechnicalError(null);
    onDirtyChange?.(true);
    setRules((current) => [
      ...current,
      createFriendlyRule(undefined, current.length),
    ]);
  }

  function removeRule(id: string) {
    setTechnicalDirty(false);
    setTechnicalError(null);
    onDirtyChange?.(true);
    setRules((current) =>
      current.length === 1 ? current : current.filter((rule) => rule.id !== id),
    );
  }

  function isAfterResponse(rule: FriendlyRule): boolean {
    return (
      rule.chargeTiming === "after-response" ||
      (rule.chargeTiming === undefined && rule.holdUsd.trim() !== "")
    );
  }

  async function saveRules() {
    if (activeError) {
      toast({ title: activeError, variant: "error" });
      return;
    }

    setSaving(true);
    try {
      const payloadRules = technicalDirty
        ? parseRulesJson(technicalJson)
        : generatedRules;
      if (!onSaveRules) {
        throw new Error("Pricing rules save handler is not configured");
      }
      await onSaveRules(payloadRules);
      setRules(createFriendlyRulesFromPricingRules(payloadRules));
      setTechnicalJson(formatRulesJson(payloadRules));
      setTechnicalDirty(false);
      setTechnicalError(null);
      onDirtyChange?.(false);
      onValidChange?.(true);
      await onSaved?.();
      toast({ title: "Pricing saved", variant: "success" });
    } catch (err) {
      const message =
        err instanceof ApiError || err instanceof Error
          ? err.message
          : "Failed to save pricing";
      toast({ title: message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function copyAIPrompt() {
    try {
      await navigator.clipboard.writeText(
        buildAIPricingRulesPrompt(technicalJson),
      );
      toast({ title: "AI prompt copied", variant: "success" });
    } catch {
      toast({ title: "Failed to copy AI prompt", variant: "error" });
    }
  }

  return (
    <section className="bg-transparent">
      <div className="mb-3">
        <h3 className="text-lg font-semibold leading-7 text-gray-12">
          Pricing
        </h3>
        <p className="mt-0.5 text-sm leading-5 text-gray-11">
          Create rules in plain English.
        </p>
      </div>

      {!editable ? (
        <div className="rounded-md border border-gray-6 bg-gray-3 p-3 text-sm text-gray-11">
          {loading ? "Loading pricing rules..." : reason}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2.5">
            {rules.map((rule, index) => (
              <div
                key={rule.id}
                className="overflow-hidden rounded-md border border-gray-6"
              >
                {rules.length > 1 && (
                  <div className="flex items-center justify-between border-b border-gray-6 px-3 py-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-gray-11">
                      Rule {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeRule(rule.id)}
                      className="rounded p-1.5 text-gray-11 hover:bg-gray-4 hover:text-red-400"
                      title="Remove rule"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                )}

                <div className="grid min-h-12 grid-cols-1 items-center gap-3 border-b border-gray-6 px-3 py-2 sm:grid-cols-[112px_minmax(0,1fr)]">
                  <span className="text-sm text-gray-12">When</span>
                  <div className="grid w-full min-w-0 grid-cols-1 items-center gap-3 text-sm text-gray-12 md:grid-cols-[minmax(150px,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                    <Select.Root
                      value={rule.matchMode}
                      onValueChange={(value) =>
                        updateRule(rule.id, {
                          matchMode: value as MatchMode,
                        })
                      }
                    >
                      <Select.Trigger className="flex h-9 min-w-0 w-full items-center justify-between rounded-md border border-accent-8 bg-gray-3 px-3 text-sm text-gray-12 focus:outline-none focus:ring-1 focus:ring-accent-8">
                        <Select.Value />
                        <Select.Icon>
                          <ChevronDownIcon className="h-4 w-4 text-gray-11" />
                        </Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content
                          className="overflow-hidden rounded border border-gray-6 bg-gray-2 shadow-lg"
                          position="popper"
                          sideOffset={4}
                        >
                          <Select.Viewport className="p-1">
                            {matchModes.map((mode) => (
                              <Select.Item
                                key={mode.value}
                                value={mode.value}
                                className="relative flex cursor-pointer select-none items-center rounded px-6 py-1.5 text-sm outline-none hover:bg-gray-4 data-[highlighted]:bg-gray-4"
                              >
                                <Select.ItemIndicator className="absolute left-1 inline-flex items-center">
                                  <CheckIcon className="h-3 w-3 text-accent-11" />
                                </Select.ItemIndicator>
                                <Select.ItemText>{mode.label}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Viewport>
                        </Select.Content>
                      </Select.Portal>
                    </Select.Root>
                    {rule.matchMode !== "every-request" && (
                      <>
                        <input
                          type="text"
                          value={rule.matchField}
                          onChange={(e) =>
                            updateRule(rule.id, {
                              matchField: e.target.value,
                            })
                          }
                          placeholder=".model"
                          className="h-9 min-w-0 w-full rounded-md border border-gray-6 bg-gray-3 px-3 font-mono text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                        />
                        {rule.matchMode !== "request-field-exists" && (
                          <input
                            type="text"
                            value={rule.matchValue}
                            onChange={(e) =>
                              updateRule(rule.id, {
                                matchValue: e.target.value,
                              })
                            }
                            placeholder={
                              rule.matchMode === "request-field-matches"
                                ? "claude-sonnet.*"
                                : "gpt-4o"
                            }
                            className="h-9 min-w-0 w-full rounded-md border border-gray-6 bg-gray-3 px-3 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="grid min-h-12 grid-cols-1 items-start gap-3 px-3 py-2 sm:grid-cols-[112px_minmax(0,1fr)]">
                  <span className="flex h-9 items-center text-sm text-gray-12">
                    Charge
                  </span>
                  <div className="min-w-0 space-y-3">
                    <div className="inline-grid h-9 grid-cols-2 rounded-md border border-gray-6 bg-gray-3 p-0.5 text-sm">
                      <button
                        type="button"
                        onClick={() =>
                          updateRule(rule.id, {
                            chargeTiming: "upfront",
                            holdUsd: "",
                            captureMode:
                              rule.captureMode === "response-field"
                                ? "fixed"
                                : rule.captureMode,
                            captureSource:
                              rule.captureMode === "response-field"
                                ? "request-body"
                                : rule.captureSource,
                          })
                        }
                        className={`rounded px-3 text-gray-11 transition-colors ${
                          !isAfterResponse(rule)
                            ? "bg-gray-1 text-gray-12 shadow-sm"
                            : "hover:bg-gray-4"
                        }`}
                      >
                        Upfront
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateRule(rule.id, {
                            chargeTiming: "after-response",
                            holdUsd: rule.holdUsd.trim() || "1",
                          })
                        }
                        className={`rounded px-3 text-gray-11 transition-colors ${
                          isAfterResponse(rule)
                            ? "bg-gray-1 text-gray-12 shadow-sm"
                            : "hover:bg-gray-4"
                        }`}
                      >
                        After response
                      </button>
                    </div>
                    <div className="grid w-full min-w-0 grid-cols-1 items-center gap-3 text-sm text-gray-12 md:grid-cols-[minmax(88px,112px)_minmax(64px,72px)_minmax(132px,180px)_minmax(0,1fr)_minmax(88px,112px)]">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={rule.amountUsd}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value === "" || /^\d*\.?\d*$/.test(value)) {
                            updateRule(rule.id, { amountUsd: value });
                          }
                        }}
                        className="h-9 min-w-0 w-full rounded-md border border-gray-6 bg-gray-3 px-3 text-sm text-gray-12 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                      />
                      <span className="flex h-9 min-w-0 items-center rounded-md border border-gray-6 bg-gray-3 px-3 text-sm text-gray-12">
                        USD
                      </span>
                      <Select.Root
                        value={rule.captureMode}
                        onValueChange={(value) =>
                          updateRule(rule.id, {
                            captureMode: value as AmountMode,
                            holdUsd:
                              value === "response-field" &&
                              rule.chargeTiming === "upfront" &&
                              rule.holdUsd.trim() === ""
                                ? "1"
                                : rule.holdUsd,
                            chargeTiming:
                              value === "response-field"
                                ? "after-response"
                                : rule.chargeTiming,
                            captureSource:
                              value === "response-field"
                                ? "response-body"
                                : "request-body",
                          })
                        }
                      >
                        <Select.Trigger className="flex h-9 min-w-0 w-full items-center justify-between rounded-md border border-gray-6 bg-gray-3 px-3 text-sm text-gray-12 focus:outline-none focus:ring-1 focus:ring-accent-8">
                          <Select.Value />
                          <Select.Icon>
                            <ChevronDownIcon className="h-4 w-4 text-gray-11" />
                          </Select.Icon>
                        </Select.Trigger>
                        <Select.Portal>
                          <Select.Content
                            className="overflow-hidden rounded border border-gray-6 bg-gray-2 shadow-lg"
                            position="popper"
                            sideOffset={4}
                          >
                            <Select.Viewport className="p-1">
                              {chargeAmountModes.map((mode) => (
                                <Select.Item
                                  key={mode.value}
                                  value={mode.value}
                                  className="relative flex cursor-pointer select-none items-center rounded px-6 py-1.5 text-sm outline-none hover:bg-gray-4 data-[highlighted]:bg-gray-4"
                                >
                                  <Select.ItemIndicator className="absolute left-1 inline-flex items-center">
                                    <CheckIcon className="h-3 w-3 text-accent-11" />
                                  </Select.ItemIndicator>
                                  <Select.ItemText>
                                    {mode.label}
                                  </Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.Viewport>
                          </Select.Content>
                        </Select.Portal>
                      </Select.Root>
                      {rule.captureMode !== "fixed" ? (
                        <>
                          <input
                            type="text"
                            value={rule.captureField}
                            onChange={(e) =>
                              updateRule(rule.id, {
                                captureField: e.target.value,
                              })
                            }
                            placeholder=".usage.total_tokens"
                            className="h-9 min-w-0 w-full rounded-md border border-gray-6 bg-gray-3 px-3 font-mono text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                          />
                          <input
                            type="text"
                            value={rule.captureFallback}
                            onChange={(e) =>
                              updateRule(rule.id, {
                                captureFallback: e.target.value,
                              })
                            }
                            placeholder="fallback"
                            className="h-9 min-w-0 w-full rounded-md border border-gray-6 bg-gray-3 px-3 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                          />
                        </>
                      ) : (
                        <div className="md:col-span-2" />
                      )}
                    </div>

                    {isAfterResponse(rule) && (
                      <div className="grid w-full min-w-0 grid-cols-1 items-center gap-3 border-t border-gray-6 pt-3 text-sm text-gray-12 md:grid-cols-[minmax(88px,112px)_minmax(64px,72px)_minmax(132px,180px)_minmax(0,1fr)_minmax(88px,112px)]">
                        <span className="text-gray-11">Max upfront</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={rule.holdUsd}
                          onChange={(e) => {
                            const value = e.target.value;
                            if (value === "" || /^\d*\.?\d*$/.test(value)) {
                              updateRule(rule.id, {
                                chargeTiming: "after-response",
                                holdUsd: value,
                              });
                            }
                          }}
                          className="h-9 min-w-0 w-full rounded-md border border-gray-6 bg-gray-3 px-3 text-sm text-gray-12 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                        />
                        <Select.Root
                          value={rule.authorizeMode}
                          onValueChange={(value) =>
                            updateRule(rule.id, {
                              authorizeMode: value as AmountMode,
                            })
                          }
                        >
                          <Select.Trigger className="flex h-9 min-w-0 w-full items-center justify-between rounded-md border border-gray-6 bg-gray-3 px-3 text-sm text-gray-12 focus:outline-none focus:ring-1 focus:ring-accent-8">
                            <Select.Value />
                            <Select.Icon>
                              <ChevronDownIcon className="h-4 w-4 text-gray-11" />
                            </Select.Icon>
                          </Select.Trigger>
                          <Select.Portal>
                            <Select.Content
                              className="overflow-hidden rounded border border-gray-6 bg-gray-2 shadow-lg"
                              position="popper"
                              sideOffset={4}
                            >
                              <Select.Viewport className="p-1">
                                {reserveAmountModes.map((mode) => (
                                  <Select.Item
                                    key={mode.value}
                                    value={mode.value}
                                    className="relative flex cursor-pointer select-none items-center rounded px-6 py-1.5 text-sm outline-none hover:bg-gray-4 data-[highlighted]:bg-gray-4"
                                  >
                                    <Select.ItemIndicator className="absolute left-1 inline-flex items-center">
                                      <CheckIcon className="h-3 w-3 text-accent-11" />
                                    </Select.ItemIndicator>
                                    <Select.ItemText>
                                      {mode.label}
                                    </Select.ItemText>
                                  </Select.Item>
                                ))}
                              </Select.Viewport>
                            </Select.Content>
                          </Select.Portal>
                        </Select.Root>
                        {rule.authorizeMode !== "fixed" ? (
                          <>
                            <input
                              type="text"
                              value={rule.authorizeField}
                              onChange={(e) =>
                                updateRule(rule.id, {
                                  authorizeField: e.target.value,
                                })
                              }
                              placeholder=".max_tokens"
                              className="h-9 min-w-0 w-full rounded-md border border-gray-6 bg-gray-3 px-3 font-mono text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                            />
                            <input
                              type="text"
                              value={rule.authorizeFallback}
                              onChange={(e) =>
                                updateRule(rule.id, {
                                  authorizeFallback: e.target.value,
                                })
                              }
                              placeholder="fallback"
                              className="h-9 min-w-0 w-full rounded-md border border-gray-6 bg-gray-3 px-3 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                            />
                          </>
                        ) : (
                          <div className="md:col-span-2" />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={addRule}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-6 bg-gray-3 px-2.5 text-xs font-medium text-gray-12 hover:bg-gray-4"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Add rule
            </button>
          </div>

          <div className="rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm leading-5 text-gray-11">
            <span className="font-medium text-gray-12">Preview:</span>{" "}
            {buildRulesSummary(rules)}
          </div>
          {activeError && (
            <p className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              {activeError}
            </p>
          )}

          <div className="rounded-md bg-gray-2">
            <button
              type="button"
              onClick={() => setTechnicalOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-gray-3"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-gray-12">
                {technicalOpen ? (
                  <CaretDownIcon className="h-4 w-4" />
                ) : (
                  <CaretRightIcon className="h-4 w-4" />
                )}
                Technical JSON
              </span>
              <span className="hidden text-xs font-normal text-gray-10 sm:inline">
                Editable advanced rule
              </span>
            </button>
            {technicalOpen && (
              <div className="space-y-2.5 border-t border-gray-6 p-3">
                <div className="flex flex-col gap-3 rounded-md border border-gray-6 bg-gray-3 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-12">
                      AI rule helper
                    </p>
                    <p className="mt-0.5 text-xs leading-5 text-gray-10">
                      Copy a prompt for Claude or Codex, then paste the
                      generated pricing JSON into the raw editor.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyAIPrompt()}
                    className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-gray-7 bg-gray-2 px-2.5 text-xs font-medium text-gray-12 hover:bg-gray-4"
                  >
                    <CopyIcon className="h-3.5 w-3.5" />
                    Copy AI prompt
                  </button>
                </div>
                <div className="overflow-hidden rounded-md border border-gray-5 bg-gray-1 shadow-inner transition-colors focus-within:border-gray-7 focus-within:ring-1 focus-within:ring-white/10">
                  <div className="flex items-center justify-between border-b border-gray-6 bg-gray-3 px-3 py-1.5">
                    <span className="text-xs font-medium text-gray-11">
                      Raw editor
                    </span>
                    <span className="text-xs text-gray-10">
                      {technicalJson.split("\n").length} lines
                    </span>
                  </div>
                  <textarea
                    value={technicalJson}
                    onChange={(e) => {
                      const nextJson = e.target.value;
                      onDirtyChange?.(true);
                      setTechnicalDirty(true);
                      setTechnicalJson(nextJson);
                      try {
                        const parsedRules = parseRulesJson(nextJson);
                        setRules(
                          createFriendlyRulesFromPricingRules(parsedRules),
                        );
                        setTechnicalError(null);
                        onRulesChange?.(parsedRules);
                        onValidChange?.(true);
                      } catch (err) {
                        setTechnicalError(
                          err instanceof Error
                            ? err.message
                            : "Technical JSON is invalid",
                        );
                        onValidChange?.(false);
                      }
                    }}
                    spellCheck={false}
                    aria-label="Editable technical pricing JSON"
                    className="min-h-44 w-full resize-y bg-gray-1 p-3 font-mono text-xs leading-5 text-gray-12 placeholder-gray-9 selection:bg-accent-8/30 focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>

          {showSaveButton &&
            (mode === "tenant" || endpointId !== undefined) && (
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => void saveRules()}
                  disabled={saving || activeError !== null}
                  className="h-9 rounded-md bg-accent-9 px-4 text-sm font-medium text-white shadow-button hover:bg-accent-10 disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save pricing"}
                </button>
              </div>
            )}
        </div>
      )}
    </section>
  );
}
