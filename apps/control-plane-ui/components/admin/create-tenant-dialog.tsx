"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Checkbox from "@radix-ui/react-checkbox";
import * as Select from "@radix-ui/react-select";
import {
  Cross2Icon,
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  MinusIcon,
  CheckCircledIcon,
  CrossCircledIcon,
  EyeOpenIcon,
  EyeClosedIcon,
  InfoCircledIcon,
} from "@radix-ui/react-icons";
import useSWR from "swr";
import { api } from "@/lib/api/client";
import {
  DEFAULT_SCHEME,
  SCHEME_OPTIONS,
  isScheme,
  MIN_PRICE_USD,
  MAX_PRICE_USD,
} from "@/lib/types/api";
import { useToast } from "@/components/ui/toast";
import { TagsInput } from "@/components/shared/tags-input";
import { sanitizeProxyName } from "@/lib/proxy-name";
import { getProxyUrlPattern } from "@/lib/format";
import {
  type HeaderType,
  type ValueFormat,
  isBlockedHeader,
  composeFinalHeader,
  composeFinalValue,
  maskToken,
} from "@/lib/auth-header";
import {
  PricingRulesForm,
  type PricingRule,
} from "@/components/proxy-endpoints/pricing-rules-form";

interface Node {
  id: number;
  name: string;
  status: string;
  tenant_count: number;
}

interface Organization {
  id: number;
  name: string;
  slug: string;
  is_admin: boolean;
}

interface Wallet {
  id: number;
  name: string;
  organization_id: number | null;
  funding_status: string;
}

interface CreateTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function CreateTenantDialog({
  open,
  onOpenChange,
  onSuccess,
}: CreateTenantDialogProps) {
  const { toast } = useToast();
  const { data: nodes } = useSWR(
    open ? "/api/admin/nodes" : null,
    api.get<Node[]>,
  );
  const { data: organizations } = useSWR(
    open ? "/api/admin/organizations" : null,
    api.get<Organization[]>,
  );
  const { data: allWallets } = useSWR(
    open ? "/api/admin/wallets" : null,
    api.get<Wallet[]>,
  );

  const [name, setName] = useState("");
  const [selectedNodeIds, setSelectedNodeIds] = useState<number[]>([]);
  const [backendUrl, setBackendUrl] = useState("");
  const [headerType, setHeaderType] = useState<HeaderType>("Authorization");
  const [customHeader, setCustomHeader] = useState("");
  const [valueFormat, setValueFormat] = useState<ValueFormat>("bearer");
  const [customPrefix, setCustomPrefix] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [organizationId, setOrganizationId] = useState<string | null>(null); // null = not selected, "none" = no org, "123" = org id
  const [walletId, setWalletId] = useState<number | null>(null);
  const [defaultPrice, setDefaultPrice] = useState("0.01");
  const [defaultScheme, setDefaultScheme] = useState(DEFAULT_SCHEME);
  const [rootPricingRules, setRootPricingRules] = useState<PricingRule[]>([]);
  const [rootPricingRulesDirty, setRootPricingRulesDirty] = useState(false);
  const [rootPricingRulesValid, setRootPricingRulesValid] = useState(true);
  const [registerOnly, setRegisterOnly] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [isCheckingName, setIsCheckingName] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [showAuthValue, setShowAuthValue] = useState(false);
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const orgSelectionMade = organizationId !== null;
  const isFlexScheme = defaultScheme === "flex";
  const shouldPersistRootPricingRules =
    isFlexScheme && rootPricingRules.length > 0;
  const isLegacyMode = organizationId === "none";
  const selectedOrg =
    organizationId && organizationId !== "none"
      ? organizations?.find((o) => o.id === parseInt(organizationId))
      : null;

  const handleDefaultSchemeChange = (value: string) => {
    if (isScheme(value)) {
      setDefaultScheme(value);
    }
  };

  const getFinalAuthHeader = () => {
    if (!authToken.trim()) return null;
    return composeFinalHeader(headerType, customHeader);
  };

  const getFinalAuthValue = () => {
    if (!authToken.trim()) return null;
    return composeFinalValue(valueFormat, customPrefix, authToken);
  };

  const isDirty = useCallback(() => {
    return (
      name.trim() !== "" ||
      selectedNodeIds.length > 0 ||
      backendUrl.trim() !== "" ||
      authToken.trim() !== "" ||
      customHeader.trim() !== "" ||
      customPrefix.trim() !== "" ||
      organizationId !== null ||
      walletId !== null ||
      defaultPrice !== "0.01" ||
      defaultScheme !== DEFAULT_SCHEME ||
      rootPricingRulesDirty ||
      registerOnly ||
      tags.length > 0
    );
  }, [
    name,
    selectedNodeIds,
    backendUrl,
    authToken,
    customHeader,
    customPrefix,
    organizationId,
    walletId,
    defaultPrice,
    defaultScheme,
    rootPricingRulesDirty,
    registerOnly,
    tags,
  ]);

  const attemptClose = useCallback(() => {
    if (isDirty()) {
      setShowDiscardConfirm(true);
    } else {
      onOpenChange(false);
    }
  }, [isDirty, onOpenChange]);

  useEffect(() => {
    if (!name.trim() || !orgSelectionMade) {
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
          const sanitized = sanitizeProxyName(name);
          if (!sanitized) {
            setNameAvailable(null);
            setIsCheckingName(false);
            return;
          }

          let checkUrl = `/api/admin/tenants/check-name?name=${encodeURIComponent(sanitized)}`;
          if (!isLegacyMode && organizationId) {
            checkUrl += `&organization_id=${organizationId}`;
          }

          const result = await api.get<{ available: boolean }>(checkUrl);
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
  }, [name, orgSelectionMade, isLegacyMode, organizationId]);

  // Reset name availability when org or name changes
  useEffect(() => {
    if (name.trim()) {
      setNameAvailable(null);
    }
  }, [organizationId, name]);

  const availableWallets = allWallets?.filter((w) => {
    if (!organizationId || organizationId === "none") {
      // No org selected - show master wallets only
      return w.organization_id === null;
    }
    // Org selected - show org's wallets and master wallets
    return (
      w.organization_id === parseInt(organizationId) ||
      w.organization_id === null
    );
  });

  // Reset wallet selection when organization changes
  useEffect(() => {
    if (walletId && availableWallets) {
      const walletStillAvailable = availableWallets.some(
        (w) => w.id === walletId,
      );
      if (!walletStillAvailable) {
        setWalletId(null);
      }
    }
  }, [organizationId, availableWallets, walletId]);

  const resetForm = () => {
    setName("");
    setSelectedNodeIds([]);
    setBackendUrl("");
    setHeaderType("Authorization");
    setCustomHeader("");
    setValueFormat("bearer");
    setCustomPrefix("");
    setAuthToken("");
    setOrganizationId(null);
    setWalletId(null);
    setDefaultPrice("0.01");
    setDefaultScheme(DEFAULT_SCHEME);
    setRootPricingRules([]);
    setRootPricingRulesDirty(false);
    setRootPricingRulesValid(true);
    setRegisterOnly(false);
    setTags([]);
    setError("");
    setNameAvailable(null);
    setIsCheckingName(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      attemptClose();
      return;
    }
    onOpenChange(newOpen);
  };

  const confirmDiscard = () => {
    setShowDiscardConfirm(false);
    resetForm();
    onOpenChange(false);
  };

  const handleSubmit = async (
    e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    e.preventDefault();
    setError("");

    const finalHeader = getFinalAuthHeader();
    const finalValue = getFinalAuthValue();

    if (!orgSelectionMade) {
      setError("Please select an organization option first");
      return;
    }
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (selectedNodeIds.length === 0) {
      setError("At least one node is required");
      return;
    }
    if (!backendUrl.trim()) {
      setError("Backend URL is required");
      return;
    }
    if (headerType === "custom" && customHeader.trim()) {
      if (isBlockedHeader(customHeader.trim())) {
        setError(`Header "${customHeader}" is not allowed`);
        return;
      }
      if (customHeader.trim().toLowerCase().startsWith("proxy-")) {
        setError("Proxy-* headers are not allowed");
        return;
      }
    }
    if (isFlexScheme && !rootPricingRulesValid) {
      setError("Fix pricing rules before creating the tenant");
      return;
    }

    setIsSubmitting(true);
    try {
      await api.post("/api/admin/tenants", {
        name: name.trim(),
        node_ids: selectedNodeIds,
        backend_url: backendUrl.trim(),
        upstream_auth_header: finalHeader,
        upstream_auth_value: finalValue,
        organization_id:
          organizationId && organizationId !== "none"
            ? parseInt(organizationId)
            : null,
        wallet_id: walletId,
        default_price: Math.round((parseFloat(defaultPrice) || 0) * 1_000_000),
        default_scheme: defaultScheme,
        ...(shouldPersistRootPricingRules && {
          pricing_rules: rootPricingRules,
        }),
        register_only: registerOnly,
        tags: tags.length > 0 ? tags : undefined,
      });
      resetForm();
      onOpenChange(false);
      toast({
        title: "Tenant created",
        description: `${name.trim()} has been created successfully.`,
        variant: "success",
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tenant");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getUrlPreview = () => {
    if (!orgSelectionMade) {
      return null; // Don't show preview until org is selected
    }

    const sanitized = sanitizeProxyName(name) || "<name>";

    if (isLegacyMode) {
      return getProxyUrlPattern({
        proxyName: sanitized,
      });
    } else if (selectedOrg) {
      return getProxyUrlPattern({
        proxyName: sanitized,
        orgSlug: selectedOrg.slug,
      });
    }

    return null;
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-gray-6 bg-gray-1 p-6 shadow-xl"
          onInteractOutside={(e) => {
            if (isDirty()) {
              e.preventDefault();
              setShowDiscardConfirm(true);
            }
          }}
          onEscapeKeyDown={(e) => {
            if (isDirty()) {
              e.preventDefault();
              setShowDiscardConfirm(true);
            }
          }}
        >
          <div className="mb-6 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-gray-12">
              New Tenant
            </Dialog.Title>
            <button
              type="button"
              onClick={attemptClose}
              className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
            >
              <Cross2Icon className="h-4 w-4" />
            </button>
          </div>

          {/* URL Preview */}
          <div className="mb-6 rounded-md border border-gray-6 bg-gray-2 px-4 py-3 text-center">
            <p className="text-xs text-gray-11 mb-1">
              Tenant will be available at
            </p>
            <div className="flex items-center justify-center gap-2">
              <code className="font-mono text-sm">
                {!orgSelectionMade ? (
                  <span className="text-gray-9">Select organization first</span>
                ) : getUrlPreview() ? (
                  <>
                    {name.trim() ? (
                      <span className="text-gray-12">{getUrlPreview()}</span>
                    ) : (
                      <>
                        <span className="text-gray-9">&lt;name&gt;</span>
                        <span className="text-gray-12">
                          {getProxyUrlPattern({
                            proxyName: "",
                            orgSlug: isLegacyMode ? null : selectedOrg?.slug,
                          })}
                        </span>
                      </>
                    )}
                  </>
                ) : null}
              </code>
              {orgSelectionMade && name.trim() && (
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
            {orgSelectionMade &&
              name.trim() &&
              nameAvailable === false &&
              !isCheckingName && (
                <p className="mt-1 text-xs text-red-400">
                  This name is already taken
                  {!isLegacyMode && selectedOrg && ` in ${selectedOrg.name}`}
                </p>
              )}
          </div>

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6">
            {/* Organization - FIRST */}
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-11">
                Organization <span className="text-red-400">*</span>
              </h3>
              <div>
                <Select.Root
                  value={organizationId ?? undefined}
                  onValueChange={(value) => setOrganizationId(value)}
                >
                  <Select.Trigger
                    className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-8 ${
                      organizationId === null
                        ? "border-accent-8 bg-gray-2 text-gray-11"
                        : "border-gray-6 bg-gray-2 text-gray-12"
                    }`}
                  >
                    <Select.Value placeholder="Select organization mode..." />
                    <Select.Icon>
                      <ChevronDownIcon className="h-4 w-4 text-gray-11" />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content
                      className="overflow-hidden rounded-md border border-gray-6 bg-gray-2 shadow-lg"
                      position="popper"
                      sideOffset={4}
                    >
                      <Select.Viewport className="p-1">
                        <Select.Item
                          value="none"
                          className="relative flex cursor-pointer select-none items-center rounded px-8 py-2 text-sm outline-none hover:bg-gray-4 data-[highlighted]:bg-gray-4"
                        >
                          <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                            <CheckIcon className="h-4 w-4 text-accent-11" />
                          </Select.ItemIndicator>
                          <Select.ItemText>
                            <span className="text-yellow-400">
                              No organization
                            </span>
                            <span className="text-gray-11">
                              {" "}
                              (legacy format)
                            </span>
                          </Select.ItemText>
                        </Select.Item>
                        <div className="my-1 h-px bg-gray-6" />
                        {organizations?.map((org) => (
                          <Select.Item
                            key={org.id}
                            value={String(org.id)}
                            className="relative flex cursor-pointer select-none items-center rounded px-8 py-2 text-sm outline-none hover:bg-gray-4 data-[highlighted]:bg-gray-4"
                          >
                            <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                              <CheckIcon className="h-4 w-4 text-accent-11" />
                            </Select.ItemIndicator>
                            <Select.ItemText>
                              <span>{org.name}</span>
                              <span className="ml-2 text-gray-11">
                                ({org.slug})
                              </span>
                            </Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>
            </section>

            {/* Basic Info */}
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-11">
                Basic Info
              </h3>
              <div>
                <label className="mb-1.5 block text-sm text-gray-11">
                  Tenant Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={
                    orgSelectionMade
                      ? "my-api-tenant"
                      : "Select organization first"
                  }
                  disabled={!orgSelectionMade}
                  className={`w-full rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8 ${
                    !orgSelectionMade ? "cursor-not-allowed opacity-50" : ""
                  }`}
                />
              </div>
            </section>

            {/* Tags */}
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-11">
                Tags
              </h3>
              <TagsInput
                tags={tags}
                onChange={setTags}
                placeholder="Add tags to categorize this tenant..."
              />
            </section>

            {/* Infrastructure */}
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-11">
                Infrastructure
              </h3>
              <div>
                <label className="mb-1.5 block text-sm text-gray-11">
                  Nodes <span className="text-red-400">*</span>
                </label>
                <div className="space-y-2 rounded-md border border-gray-6 bg-gray-2 p-3">
                  {nodes
                    ?.filter((n) => n.status === "active")
                    .map((node) => {
                      const isChecked = selectedNodeIds.includes(node.id);
                      const isPrimary = selectedNodeIds[0] === node.id;
                      return (
                        <label
                          key={node.id}
                          className="flex cursor-pointer items-center gap-3 rounded-md p-2 transition-colors hover:bg-gray-3"
                        >
                          <Checkbox.Root
                            checked={isChecked}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedNodeIds([
                                  ...selectedNodeIds,
                                  node.id,
                                ]);
                              } else {
                                setSelectedNodeIds(
                                  selectedNodeIds.filter(
                                    (id) => id !== node.id,
                                  ),
                                );
                              }
                            }}
                            className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                              isChecked
                                ? "border-gray-12 bg-gray-12"
                                : "border-gray-6 bg-gray-3 hover:border-gray-8"
                            }`}
                          >
                            <Checkbox.Indicator>
                              <CheckIcon className="h-3.5 w-3.5 text-gray-1" />
                            </Checkbox.Indicator>
                          </Checkbox.Root>
                          <div className="flex flex-1 items-center justify-between">
                            <span className="text-sm text-gray-12">
                              {node.name}
                            </span>
                            <div className="flex items-center gap-2">
                              {isPrimary && (
                                <span className="rounded-full border border-blue-800 bg-blue-900/50 px-2 py-0.5 text-xs text-blue-400">
                                  Primary
                                </span>
                              )}
                              <span className="text-xs text-gray-11">
                                {node.tenant_count} tenant
                                {node.tenant_count !== 1 ? "s" : ""}
                              </span>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  {nodes?.filter((n) => n.status === "active").length === 0 && (
                    <p className="text-sm text-gray-11">
                      No active nodes available
                    </p>
                  )}
                </div>
              </div>
            </section>

            {/* Backend */}
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-11">
                Backend
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm text-gray-11">
                    Backend URL <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="url"
                    value={backendUrl}
                    onChange={(e) => setBackendUrl(e.target.value)}
                    placeholder="https://api.example.com"
                    className="w-full rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                  />
                </div>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1.5 block text-sm text-gray-11">
                        Auth Header
                      </label>
                      <Select.Root
                        value={headerType}
                        onValueChange={(value) =>
                          setHeaderType(value as typeof headerType)
                        }
                      >
                        <Select.Trigger className="flex w-full items-center justify-between rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8">
                          <Select.Value />
                          <Select.Icon>
                            <ChevronDownIcon className="h-4 w-4 text-gray-11" />
                          </Select.Icon>
                        </Select.Trigger>
                        <Select.Portal>
                          <Select.Content
                            className="overflow-hidden rounded-md border border-gray-6 bg-gray-2 shadow-lg"
                            position="popper"
                            sideOffset={4}
                          >
                            <Select.Viewport className="p-1">
                              {[
                                "Authorization",
                                "X-API-Key",
                                "X-Auth-Token",
                                "Api-Key",
                                "custom",
                              ].map((opt) => (
                                <Select.Item
                                  key={opt}
                                  value={opt}
                                  className="relative flex cursor-pointer select-none items-center rounded px-8 py-2 text-sm outline-none hover:bg-gray-4 data-[highlighted]:bg-gray-4"
                                >
                                  <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                                    <CheckIcon className="h-4 w-4 text-accent-11" />
                                  </Select.ItemIndicator>
                                  <Select.ItemText>
                                    {opt === "custom" ? "Custom" : opt}
                                  </Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.Viewport>
                          </Select.Content>
                        </Select.Portal>
                      </Select.Root>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm text-gray-11">
                        Value Format
                      </label>
                      <Select.Root
                        value={valueFormat}
                        onValueChange={(value) =>
                          setValueFormat(value as typeof valueFormat)
                        }
                      >
                        <Select.Trigger className="flex w-full items-center justify-between rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8">
                          <Select.Value>
                            {valueFormat === "bearer"
                              ? "Bearer"
                              : valueFormat === "basic"
                                ? "Basic"
                                : valueFormat === "none"
                                  ? "None (raw)"
                                  : "Custom"}
                          </Select.Value>
                          <Select.Icon>
                            <ChevronDownIcon className="h-4 w-4 text-gray-11" />
                          </Select.Icon>
                        </Select.Trigger>
                        <Select.Portal>
                          <Select.Content
                            className="overflow-hidden rounded-md border border-gray-6 bg-gray-2 shadow-lg"
                            position="popper"
                            sideOffset={4}
                          >
                            <Select.Viewport className="p-1">
                              {[
                                { value: "bearer", label: "Bearer" },
                                { value: "basic", label: "Basic" },
                                { value: "none", label: "None (raw)" },
                                { value: "custom", label: "Custom" },
                              ].map((opt) => (
                                <Select.Item
                                  key={opt.value}
                                  value={opt.value}
                                  className="relative flex cursor-pointer select-none items-center rounded px-8 py-2 text-sm outline-none hover:bg-gray-4 data-[highlighted]:bg-gray-4"
                                >
                                  <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                                    <CheckIcon className="h-4 w-4 text-accent-11" />
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
                  {headerType === "custom" && (
                    <div>
                      <label className="mb-1.5 block text-sm text-gray-11">
                        Custom Header Name
                      </label>
                      <input
                        type="text"
                        value={customHeader}
                        onChange={(e) => setCustomHeader(e.target.value)}
                        placeholder="X-Custom-Auth"
                        className="w-full rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                      />
                    </div>
                  )}
                  {valueFormat === "custom" && (
                    <div>
                      <label className="mb-1.5 block text-sm text-gray-11">
                        Custom Prefix
                      </label>
                      <input
                        type="text"
                        value={customPrefix}
                        onChange={(e) => setCustomPrefix(e.target.value)}
                        placeholder="Token"
                        className="w-full rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                      />
                    </div>
                  )}
                  <div>
                    <label className="mb-1.5 block text-sm text-gray-11">
                      Token / API Key
                    </label>
                    <div className="relative">
                      <input
                        type={showAuthValue ? "text" : "password"}
                        value={authToken}
                        onChange={(e) => setAuthToken(e.target.value)}
                        placeholder="Your secret token or API key"
                        className="w-full rounded-md border border-gray-6 bg-gray-2 px-3 py-2 pr-9 text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                      />
                      <button
                        type="button"
                        onClick={() => setShowAuthValue(!showAuthValue)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-11 hover:text-gray-12"
                      >
                        {showAuthValue ? (
                          <EyeOpenIcon className="h-4 w-4" />
                        ) : (
                          <EyeClosedIcon className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    {getFinalAuthHeader() && (
                      <p className="mt-1.5 text-xs text-gray-9">
                        Final header:{" "}
                        <code className="text-gray-11">
                          {getFinalAuthHeader()}:{" "}
                          {composeFinalValue(
                            valueFormat,
                            customPrefix,
                            maskToken(authToken),
                          )}
                        </code>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* Wallet */}
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-11">
                Wallet
              </h3>
              <div>
                <label className="mb-1.5 block text-sm text-gray-11">
                  Select Wallet
                </label>
                <Select.Root
                  value={walletId?.toString() ?? ""}
                  onValueChange={(value) =>
                    setWalletId(value ? Number(value) : null)
                  }
                >
                  <Select.Trigger className="flex w-full items-center justify-between rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8">
                    <Select.Value placeholder="Select a wallet" />
                    <Select.Icon>
                      <ChevronDownIcon className="h-4 w-4 text-gray-11" />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content
                      className="overflow-hidden rounded-md border border-gray-6 bg-gray-2 shadow-lg"
                      position="popper"
                      sideOffset={4}
                    >
                      <Select.Viewport className="p-1">
                        {!availableWallets?.length && (
                          <div className="px-3 py-2 text-sm text-gray-11">
                            No wallets available
                          </div>
                        )}
                        {availableWallets?.map((wallet) => {
                          const isMaster = wallet.organization_id === null;
                          const isUnfunded = wallet.funding_status !== "funded";
                          return (
                            <Select.Item
                              key={wallet.id}
                              value={wallet.id.toString()}
                              disabled={isUnfunded}
                              className="relative flex w-full cursor-pointer select-none items-center justify-between gap-4 rounded px-8 py-2 text-sm outline-none hover:bg-gray-4 data-[highlighted]:bg-gray-4 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[disabled]:hover:bg-transparent"
                            >
                              <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                                <CheckIcon className="h-4 w-4 text-accent-11" />
                              </Select.ItemIndicator>
                              <Select.ItemText>
                                <span
                                  className={isMaster ? "text-purple-400" : ""}
                                >
                                  {wallet.name}
                                </span>
                              </Select.ItemText>
                              <div className="flex items-center gap-2">
                                {isMaster && (
                                  <span className="rounded-full border border-purple-800 bg-purple-900/30 px-2 py-0.5 text-xs text-purple-400">
                                    master
                                  </span>
                                )}
                                {isUnfunded && (
                                  <span className="rounded-full border border-yellow-800 bg-yellow-900/30 px-2 py-0.5 text-xs text-yellow-400">
                                    unfunded
                                  </span>
                                )}
                              </div>
                            </Select.Item>
                          );
                        })}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
                <p className="mt-1 text-xs text-gray-9">
                  {organizationId && organizationId !== "none"
                    ? "Showing organization wallets and master wallets"
                    : "Showing master wallets only"}
                </p>
              </div>
            </section>

            {/* Pricing */}
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-11">
                Pricing
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-sm text-gray-11">
                    Default Price
                  </label>
                  <div className="flex items-center gap-0 rounded-md border border-gray-6 bg-gray-2">
                    <button
                      type="button"
                      disabled={isFlexScheme}
                      onClick={() => {
                        const val = Math.max(
                          0,
                          parseFloat(defaultPrice) - 0.01,
                        );
                        setDefaultPrice(
                          val.toFixed(6).replace(/\.?0+$/, "") || "0",
                        );
                      }}
                      className="flex h-9 w-9 items-center justify-center text-gray-11 hover:bg-gray-3 hover:text-gray-12 transition-colors rounded-l-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-gray-11"
                    >
                      <MinusIcon className="h-4 w-4" />
                    </button>
                    <div className="flex flex-1 items-center">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={defaultPrice}
                        disabled={isFlexScheme}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === "" || /^\d*\.?\d*$/.test(val)) {
                            setDefaultPrice(val);
                          }
                        }}
                        className="w-full bg-transparent py-2 text-center text-sm text-gray-12 focus:outline-none disabled:cursor-not-allowed disabled:text-gray-9"
                      />
                      <span className="pr-2 text-xs text-gray-11">USD</span>
                    </div>
                    <button
                      type="button"
                      disabled={isFlexScheme}
                      onClick={() => {
                        const val = parseFloat(defaultPrice || "0") + 0.01;
                        setDefaultPrice(val.toFixed(6).replace(/\.?0+$/, ""));
                      }}
                      className="flex h-9 w-9 items-center justify-center text-gray-11 hover:bg-gray-3 hover:text-gray-12 transition-colors rounded-r-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-gray-11"
                    >
                      <PlusIcon className="h-4 w-4" />
                    </button>
                  </div>
                  {(() => {
                    if (isFlexScheme) {
                      return (
                        <p className="mt-1.5 text-xs text-gray-11">
                          Flex tenants use the pricing rules below.
                        </p>
                      );
                    }
                    const price = parseFloat(defaultPrice);
                    if (defaultPrice === "" || isNaN(price)) {
                      return null;
                    }
                    if (price < 0) {
                      return (
                        <p className="mt-1.5 text-xs text-red-400">
                          Price cannot be negative
                        </p>
                      );
                    }
                    if (price > MAX_PRICE_USD) {
                      return (
                        <p className="mt-1.5 text-xs text-red-400">
                          Max price is ${MAX_PRICE_USD}
                        </p>
                      );
                    }
                    if (price > 0 && price < MIN_PRICE_USD) {
                      return (
                        <p className="mt-1.5 text-xs text-red-400">
                          Min price is ${MIN_PRICE_USD} (use $0 for free)
                        </p>
                      );
                    }
                    if (price === 0) {
                      return (
                        <p className="mt-1.5 text-xs text-green-400">Free</p>
                      );
                    }
                    return (
                      <p className="mt-1.5 text-xs text-green-400">
                        ${price.toFixed(6).replace(/\.?0+$/, "")} per request
                      </p>
                    );
                  })()}
                </div>
                <div>
                  <label className="mb-1.5 block text-sm text-gray-11">
                    Scheme
                  </label>
                  <select
                    value={defaultScheme}
                    onChange={(e) => handleDefaultSchemeChange(e.target.value)}
                    className="w-full rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                  >
                    {SCHEME_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {isFlexScheme && (
                <div className="mt-4">
                  <PricingRulesForm
                    tenantId={0}
                    scheme={defaultScheme}
                    hasOpenApiLineage
                    onRulesChange={setRootPricingRules}
                    onDirtyChange={setRootPricingRulesDirty}
                    onValidChange={setRootPricingRulesValid}
                    showSaveButton={false}
                  />
                </div>
              )}
            </section>

            {/* Register Only Option */}
            <section>
              <div className="space-y-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <Checkbox.Root
                    checked={registerOnly}
                    onCheckedChange={(checked) =>
                      setRegisterOnly(checked === true)
                    }
                    className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                      registerOnly
                        ? "border-blue-600 bg-blue-600"
                        : "border-gray-6 bg-gray-3 hover:border-gray-8"
                    }`}
                  >
                    <Checkbox.Indicator>
                      <CheckIcon className="h-3.5 w-3.5 text-white" />
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                  <div className="flex-1">
                    <span className="text-sm text-gray-12">
                      Register only (don&apos;t go live yet)
                    </span>
                    <p className="mt-0.5 text-xs text-gray-11">
                      Create the tenant for tracking purposes. It can be
                      activated later.
                    </p>
                  </div>
                </label>

                {registerOnly && (
                  <div className="rounded-md border border-blue-800 bg-blue-900/20 px-3 py-2 text-sm text-blue-300">
                    <p className="flex items-start gap-2">
                      <InfoCircledIcon className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <span>
                        The tenant will be created in a{" "}
                        <strong>registered</strong> state. It won&apos;t accept
                        requests until activated.
                      </span>
                    </p>
                  </div>
                )}
              </div>
            </section>

            {error && (
              <div className="rounded-md border border-red-800 bg-red-900/20 px-3 py-2 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={attemptClose}
                className="rounded-md border border-gray-6 px-4 py-2 text-sm text-gray-11 hover:bg-gray-3"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting && (
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                )}
                {isSubmitting ? "Creating..." : "Create Tenant"}
              </button>
            </div>
          </form>

          <AlertDialog.Root
            open={showDiscardConfirm}
            onOpenChange={setShowDiscardConfirm}
          >
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" />
              <AlertDialog.Content className="fixed left-1/2 top-1/2 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-xl z-50">
                <AlertDialog.Title className="text-lg font-semibold text-gray-12">
                  Discard changes?
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-2 text-sm text-gray-11">
                  You have unsaved changes. Are you sure you want to close this
                  dialog? Your changes will be lost.
                </AlertDialog.Description>
                <div className="mt-6 flex justify-end gap-3">
                  <AlertDialog.Cancel asChild>
                    <button className="rounded-md border border-gray-6 px-4 py-2 text-sm text-gray-11 hover:bg-gray-3">
                      Keep editing
                    </button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <button
                      onClick={confirmDiscard}
                      className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
                    >
                      Discard
                    </button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
