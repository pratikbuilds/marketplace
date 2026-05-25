"use client";

const AUTO_COLLAPSE_THRESHOLD = 7;

import { useAuth } from "@/lib/auth/context";
import { getProxyUrl } from "@/lib/format";
import useSWR from "swr";
import { api } from "@/lib/api/client";
import { InlinePriceEdit } from "@/components/shared/inline-price-edit";
import { InlineSchemeEdit } from "@/components/shared/inline-scheme-edit";
import { RootPricingRulesDialog } from "@/components/proxy-endpoints/root-pricing-rules-dialog";
import Link from "next/link";
import {
  Pencil1Icon,
  CopyIcon,
  CheckIcon,
  EyeOpenIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  InfoCircledIcon,
} from "@radix-ui/react-icons";
import { useState, useEffect } from "react";
import { useToast } from "@/components/ui/toast";
import {
  type EarningsAnalytics,
  formatUSDC,
  getValueColor,
  getChangeColor,
  formatChange,
  buildTokenTooltip,
} from "@/lib/analytics";

interface Tenant {
  id: number;
  name: string;
  is_active: boolean;
  status: string;
  wallet_id: number | null;
  wallet_funding_status: string | null;
  default_price: number;
  default_scheme: string;
  org_slug?: string | null;
}

interface Endpoint {
  id: number;
  path: string | null;
  path_pattern: string;
  price: number | null;
  scheme: string | null;
  description: string | null;
  tags: string[];
  created_at: string;
}

export default function EndpointsPage() {
  const { currentOrg } = useAuth();

  const {
    data: tenants,
    isLoading,
    mutate,
  } = useSWR(
    currentOrg ? `/api/organizations/${currentOrg.id}/tenants` : null,
    api.get<Tenant[]>,
  );

  if (!currentOrg) {
    return (
      <div className="rounded-lg border border-gray-6 bg-gray-2 p-6">
        <h2 className="mb-2 text-lg font-medium text-gray-12">
          No Organization Selected
        </h2>
        <p className="text-sm text-gray-11">
          Select an organization from the sidebar to view endpoints.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-12">Endpoints</h1>
        <p className="text-sm text-gray-11">
          API endpoints for{" "}
          <span className="text-brand-orange">{currentOrg.name}</span>
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
        </div>
      ) : tenants?.length ? (
        <div className="space-y-6">
          {tenants.map((tenant) => (
            <TenantCard
              key={tenant.id}
              tenant={tenant}
              orgId={currentOrg.id}
              onUpdate={() => void mutate()}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-6 bg-gray-2 p-8 text-center">
          <h2 className="mb-2 text-lg font-medium text-gray-12">
            No endpoints yet
          </h2>
          <p className="mb-6 text-sm text-gray-11">
            Create a proxy to start managing your API endpoints.
          </p>
          <Link
            href="/proxies"
            className="inline-flex items-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90"
          >
            Create a proxy
          </Link>
        </div>
      )}
    </div>
  );
}

function TenantCard({
  tenant,
  orgId,
  onUpdate,
}: {
  tenant: Tenant;
  orgId: number;
  onUpdate: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [rootPricingOpen, setRootPricingOpen] = useState(false);
  const storageKey = `endpoints-collapsed-${tenant.id}`;
  const hasStoredPref =
    typeof window !== "undefined" && localStorage.getItem(storageKey) !== null;
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = localStorage.getItem(storageKey);
    return stored === "true";
  });
  const { toast } = useToast();
  const {
    data: endpoints,
    isLoading,
    mutate: mutateEndpoints,
  } = useSWR(`/api/tenants/${tenant.id}/endpoints`, api.get<Endpoint[]>, {
    refreshInterval: 5000,
  });

  useEffect(() => {
    if (
      !hasStoredPref &&
      endpoints &&
      endpoints.length > AUTO_COLLAPSE_THRESHOLD
    ) {
      setIsCollapsed(true);
    }
  }, [hasStoredPref, endpoints]);

  const toggleCollapsed = () => {
    const newValue = !isCollapsed;
    setIsCollapsed(newValue);
    localStorage.setItem(storageKey, String(newValue));
  };

  const apiEndpoint = `/api/organizations/${orgId}/tenants/${tenant.id}`;
  const proxyUrl = getProxyUrl({
    proxyName: tenant.name,
    orgSlug: tenant.org_slug,
  });

  const handleCopy = async () => {
    await navigator.clipboard.writeText(proxyUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: "URL copied to clipboard" });
  };

  return (
    <div className="overflow-hidden rounded-lg border border-gray-6 bg-gray-2">
      <div
        className={`flex items-center justify-between bg-gray-3 px-4 py-3 ${isCollapsed ? "" : "border-b border-gray-6"}`}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={toggleCollapsed}
            className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors"
            title={isCollapsed ? "Expand" : "Collapse"}
          >
            <ChevronDownIcon
              className={`h-4 w-4 transition-transform duration-200 ${isCollapsed ? "-rotate-90" : ""}`}
            />
          </button>
          <Link
            href={`/proxies/${tenant.id}`}
            className="text-lg font-medium text-gray-12 hover:text-accent-11 hover:underline"
          >
            {tenant.name}
          </Link>
          <div className="flex items-center rounded-lg border border-gray-6 bg-gray-3/50">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <code className="text-sm text-gray-11">{proxyUrl}</code>
            </div>
            <button
              onClick={() => void handleCopy()}
              className="border-l border-gray-6 px-2 py-1.5 text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors"
              title="Copy URL"
            >
              {copied ? (
                <CheckIcon className="h-3.5 w-3.5 text-green-400" />
              ) : (
                <CopyIcon className="h-3.5 w-3.5" />
              )}
            </button>
            <a
              href={proxyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="border-l border-gray-6 px-2 py-1.5 text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors rounded-r-lg"
              title="Open in new tab"
            >
              <ExternalLinkIcon className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/proxies/${tenant.id}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-6 bg-gray-4 px-2.5 py-1 text-xs font-medium text-gray-11 hover:bg-gray-5 hover:text-gray-12"
          >
            <EyeOpenIcon className="h-3.5 w-3.5" />
            View
          </Link>
          <Link
            href={`/proxies/${tenant.id}?tab=endpoints`}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-6 bg-gray-4 px-2.5 py-1 text-xs font-medium text-gray-11 hover:bg-gray-5 hover:text-gray-12"
          >
            <Pencil1Icon className="h-3.5 w-3.5" />
            Edit
          </Link>
        </div>
      </div>

      {!isCollapsed && (
        <div className="p-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
            </div>
          ) : (
            <>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-6 text-xs font-medium text-gray-11">
                    <th className="pb-2 text-left">Path</th>
                    <th className="w-16 pb-2 text-center">URL</th>
                    <th className="w-20 pb-2 text-right">Price</th>
                    <th className="w-20 pb-2 text-right">Scheme</th>
                    <th className="w-20 pb-2 text-right">Earned</th>
                    <th className="w-24 pb-2 text-right">This Month</th>
                    <th className="w-16 pb-2 text-right">Change</th>
                    <th className="w-16 pb-2 text-right">Calls</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-6">
                  <CatchAllRow
                    tenant={tenant}
                    orgId={orgId}
                    apiEndpoint={apiEndpoint}
                    onEditRootPricing={() => setRootPricingOpen(true)}
                    onUpdate={onUpdate}
                  />
                  {(isExpanded ? endpoints : endpoints?.slice(0, 5))?.map(
                    (endpoint) => (
                      <EndpointRow
                        key={endpoint.id}
                        endpoint={endpoint}
                        tenant={tenant}
                        orgId={orgId}
                        onUpdate={() => void mutateEndpoints()}
                      />
                    ),
                  )}
                </tbody>
              </table>
              {endpoints && endpoints.length > 5 && (
                <div className="mt-3 text-center">
                  <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="text-xs text-accent-11 hover:text-accent-12 hover:underline"
                  >
                    {isExpanded
                      ? "Show less"
                      : `Show ${endpoints.length - 5} more endpoints...`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <RootPricingRulesDialog
        open={rootPricingOpen}
        onOpenChange={setRootPricingOpen}
        tenantId={tenant.id}
        defaultSchemeApiEndpoint={apiEndpoint}
        onSaved={onUpdate}
      />
    </div>
  );
}

function CatchAllRow({
  tenant,
  orgId,
  apiEndpoint,
  onEditRootPricing,
  onUpdate,
}: {
  tenant: Tenant;
  orgId: number;
  apiEndpoint: string;
  onEditRootPricing: () => void;
  onUpdate: () => void;
}) {
  const { toast } = useToast();
  const proxyUrl = getProxyUrl({
    proxyName: tenant.name,
    orgSlug: tenant.org_slug,
  });
  const { data: analytics, isLoading } = useSWR(
    `/api/organizations/${orgId}/tenants/${tenant.id}/catch-all/analytics`,
    api.get<EarningsAnalytics>,
  );

  return (
    <>
      <tr className="bg-gray-3/50">
        <td className="py-2 align-middle">
          <code className="rounded bg-accent-4 px-1.5 py-0.5 text-xs text-accent-11">
            /
          </code>
          <span className="ml-2 text-xs text-gray-11">(catch-all)</span>
        </td>
        <td className="py-2 align-middle text-center">
          <div className="inline-flex items-center gap-1">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(proxyUrl);
                toast({ title: "URL copied to clipboard", variant: "success" });
              }}
              className="rounded border border-gray-6 p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
              title="Copy URL"
            >
              <CopyIcon className="h-3 w-3" />
            </button>
            <a
              href={proxyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-gray-6 p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
              title="Open URL"
            >
              <ExternalLinkIcon className="h-3 w-3" />
            </a>
          </div>
        </td>
        <td className="whitespace-nowrap py-2 pl-4 text-right align-middle">
          <div className="flex items-center justify-end gap-2">
            {tenant.default_scheme === "flex" ? (
              <button
                type="button"
                onClick={onEditRootPricing}
                className="group flex items-center gap-1 rounded bg-gray-4 px-2 py-1 text-xs text-gray-11 hover:bg-gray-5"
              >
                Dynamic
                <Pencil1Icon className="h-3 w-3 opacity-50 group-hover:opacity-100" />
              </button>
            ) : (
              <>
                {tenant.default_price < 0.0000001 && (
                  <span className="rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400 border border-green-800">
                    Free
                  </span>
                )}
                <InlinePriceEdit
                  priceMicro={tenant.default_price}
                  onUpdate={onUpdate}
                  apiEndpoint={apiEndpoint}
                  fieldName="default_price"
                  label="Default Price"
                />
              </>
            )}
          </div>
        </td>
        <td className="whitespace-nowrap py-2 pl-4 text-right align-middle">
          <InlineSchemeEdit
            scheme={tenant.default_scheme}
            onUpdate={onUpdate}
            apiEndpoint={apiEndpoint}
            fieldName="default_scheme"
            label="Default Scheme"
            onFullEditRequired={onEditRootPricing}
          />
        </td>
        <td
          className={`whitespace-nowrap py-2 text-right align-middle text-xs ${isLoading ? "text-gray-9" : getValueColor(analytics?.total_earned)}`}
        >
          <span className="inline-flex items-center gap-1">
            {isLoading ? "..." : formatUSDC(analytics?.total_earned)}
            {!isLoading && buildTokenTooltip(analytics?.token_breakdown) && (
              <span
                className="cursor-help text-gray-9"
                title={buildTokenTooltip(analytics?.token_breakdown)}
              >
                <InfoCircledIcon className="h-3 w-3" />
              </span>
            )}
          </span>
        </td>
        <td
          className={`whitespace-nowrap py-2 text-right align-middle text-xs ${isLoading ? "text-gray-9" : getValueColor(analytics?.current_month_earned)}`}
        >
          <span className="inline-flex items-center gap-1">
            {isLoading ? "..." : formatUSDC(analytics?.current_month_earned)}
            {!isLoading && buildTokenTooltip(analytics?.token_breakdown) && (
              <span
                className="cursor-help text-gray-9"
                title={buildTokenTooltip(analytics?.token_breakdown)}
              >
                <InfoCircledIcon className="h-3 w-3" />
              </span>
            )}
          </span>
        </td>
        <td
          className={`whitespace-nowrap py-2 text-right align-middle text-xs ${isLoading ? "text-gray-9" : getChangeColor(analytics?.percent_change)}`}
        >
          {isLoading ? "..." : formatChange(analytics?.percent_change)}
        </td>
        <td className="whitespace-nowrap py-2 text-right align-middle text-xs text-white">
          {isLoading
            ? "..."
            : (analytics?.total_transactions ?? 0).toLocaleString()}
        </td>
      </tr>
    </>
  );
}

function EndpointRow({
  endpoint,
  tenant,
  orgId,
  onUpdate,
}: {
  endpoint: Endpoint;
  tenant: Tenant;
  orgId: number;
  onUpdate: () => void;
}) {
  const { toast } = useToast();
  const proxyUrl = getProxyUrl({
    proxyName: tenant.name,
    orgSlug: tenant.org_slug,
  });
  const endpointPath = endpoint.path ?? endpoint.path_pattern;
  const fullUrl = `${proxyUrl}${endpointPath}`;
  const effectiveScheme = endpoint.scheme ?? tenant.default_scheme;
  const { data: analytics, isLoading } = useSWR(
    `/api/organizations/${orgId}/tenants/${tenant.id}/endpoints/${endpoint.id}/analytics`,
    api.get<EarningsAnalytics>,
  );

  return (
    <tr className="bg-gray-3/50">
      <td className="py-2 align-middle">
        <code className="rounded bg-accent-4 px-1.5 py-0.5 text-xs text-accent-11">
          {endpointPath}
        </code>
      </td>
      <td className="py-2 align-middle text-center">
        <div className="inline-flex items-center gap-1">
          <button
            onClick={() => {
              void navigator.clipboard.writeText(fullUrl);
              toast({ title: "URL copied to clipboard", variant: "success" });
            }}
            className="rounded border border-gray-6 p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
            title="Copy URL"
          >
            <CopyIcon className="h-3 w-3" />
          </button>
          <a
            href={fullUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-gray-6 p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
            title="Open URL"
          >
            <ExternalLinkIcon className="h-3 w-3" />
          </a>
        </div>
      </td>
      <td className="whitespace-nowrap py-2 pl-4 text-right align-middle">
        <div className="flex items-center justify-end gap-2">
          {effectiveScheme === "flex" ? (
            <Link
              href={`/proxies/${tenant.id}?tab=endpoints`}
              className="group flex items-center gap-1 rounded bg-gray-4 px-2 py-1 text-xs text-gray-11 hover:bg-gray-5"
            >
              Dynamic
              <Pencil1Icon className="h-3 w-3 opacity-50 group-hover:opacity-100" />
            </Link>
          ) : (
            <>
              {(endpoint.price ?? tenant.default_price) < 0.0000001 && (
                <span className="rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400 border border-green-800">
                  Free
                </span>
              )}
              <InlinePriceEdit
                priceMicro={endpoint.price ?? tenant.default_price}
                defaultPriceMicro={tenant.default_price}
                onUpdate={onUpdate}
                apiEndpoint={`/api/tenants/${tenant.id}/endpoints/${endpoint.id}`}
                fieldName="price"
                label="Price"
              />
            </>
          )}
        </div>
      </td>
      <td className="whitespace-nowrap py-2 pl-4 text-right align-middle">
        <InlineSchemeEdit
          scheme={endpoint.scheme ?? tenant.default_scheme}
          defaultScheme={tenant.default_scheme}
          onUpdate={onUpdate}
          apiEndpoint={`/api/tenants/${tenant.id}/endpoints/${endpoint.id}`}
          fieldName="scheme"
          label="Scheme"
          onFullEditRequired={() => {
            window.location.href = `/proxies/${tenant.id}?tab=endpoints`;
          }}
        />
      </td>
      <td
        className={`whitespace-nowrap py-2 text-right align-middle text-xs ${isLoading ? "text-gray-9" : getValueColor(analytics?.total_earned)}`}
      >
        <span className="inline-flex items-center gap-1">
          {isLoading ? "..." : formatUSDC(analytics?.total_earned)}
          {!isLoading && buildTokenTooltip(analytics?.token_breakdown) && (
            <span
              className="cursor-help text-gray-9"
              title={buildTokenTooltip(analytics?.token_breakdown)}
            >
              <InfoCircledIcon className="h-3 w-3" />
            </span>
          )}
        </span>
      </td>
      <td
        className={`whitespace-nowrap py-2 text-right align-middle text-xs ${isLoading ? "text-gray-9" : getValueColor(analytics?.current_month_earned)}`}
      >
        <span className="inline-flex items-center gap-1">
          {isLoading ? "..." : formatUSDC(analytics?.current_month_earned)}
          {!isLoading && buildTokenTooltip(analytics?.token_breakdown) && (
            <span
              className="cursor-help text-gray-9"
              title={buildTokenTooltip(analytics?.token_breakdown)}
            >
              <InfoCircledIcon className="h-3 w-3" />
            </span>
          )}
        </span>
      </td>
      <td
        className={`whitespace-nowrap py-2 text-right align-middle text-xs ${isLoading ? "text-gray-9" : getChangeColor(analytics?.percent_change)}`}
      >
        {isLoading ? "..." : formatChange(analytics?.percent_change)}
      </td>
      <td className="whitespace-nowrap py-2 text-right align-middle text-xs text-white">
        {isLoading
          ? "..."
          : (analytics?.total_transactions ?? 0).toLocaleString()}
      </td>
    </tr>
  );
}
