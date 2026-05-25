"use client";

import { useState, useMemo } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/context";
import useSWR from "swr";
import { api, ApiError } from "@/lib/api/client";
import Link from "next/link";
import {
  ChevronLeftIcon,
  CopyIcon,
  CheckIcon,
  ExternalLinkIcon,
  Cross2Icon,
  InfoCircledIcon,
  Pencil1Icon,
} from "@radix-ui/react-icons";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  type EarningsAnalytics,
  formatUSDC,
  getValueColor,
  getChangeColor,
  formatChange,
  buildTokenTooltip,
} from "@/lib/analytics";
import { useToast } from "@/components/ui/toast";
import { InlineUrlEdit } from "@/components/shared/inline-url-edit";
import { InlineActiveToggle } from "@/components/shared/inline-active-toggle";
import { InlineAuthEdit } from "@/components/shared/inline-auth-edit";
import { InlinePriceEdit } from "@/components/shared/inline-price-edit";
import { TokenPricesSection } from "@/components/shared/token-prices-section";
import { InlineSchemeEdit } from "@/components/shared/inline-scheme-edit";
import { InlineWalletSelect } from "@/components/shared/inline-wallet-select";
import { EndpointsTab } from "@/components/proxy-endpoints/endpoints-tab";
import { RootPricingRulesDialog } from "@/components/proxy-endpoints/root-pricing-rules-dialog";
import { getProxyUrl } from "@/lib/format";
import { StatusBadge } from "@/components/ui/status-badge";
import { GoLiveButton } from "@/components/shared/go-live-button";
import { type TenantNode } from "@/lib/tenant-status";

interface Tenant {
  id: number;
  name: string;
  backend_url: string;
  is_active: boolean;
  status: string;
  wallet_id: number | null;
  wallet_name: string | null;
  wallet_funding_status: string | null;
  default_price: number;
  default_scheme: string;
  upstream_auth_header: string | null;
  upstream_auth_value: string | null;
  org_slug?: string | null;
  nodes: TenantNode[];
  created_at: string;
}

interface OpenApiSpecResponse {
  spec: unknown;
  hasSpec: boolean;
}

interface DailyCallData {
  period: string;
  total: number;
  call_count: number;
}

type TabType = "overview" | "endpoints" | "settings";

export default function ProxyDetailPage() {
  const params = useParams();
  const tenantId = parseInt(params.id as string);
  const { currentOrg } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const tabParam = searchParams.get("tab");
  const activeTab: TabType =
    tabParam === "endpoints"
      ? "endpoints"
      : tabParam === "settings"
        ? "settings"
        : "overview";
  const [copied, setCopied] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [rootPricingOpen, setRootPricingOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const { toast } = useToast();

  const setActiveTab = (tab: TabType) => {
    router.push(`/proxies/${tenantId}?tab=${tab}`);
  };

  const {
    data: tenants,
    isLoading: tenantsLoading,
    mutate: mutateTenants,
  } = useSWR(
    currentOrg ? `/api/organizations/${currentOrg.id}/tenants` : null,
    api.get<Tenant[]>,
    { refreshInterval: 5000 },
  );

  const { data: specData, mutate: mutateSpec } = useSWR(
    tenantId ? `/api/tenants/${tenantId}/openapi/spec` : null,
    api.get<OpenApiSpecResponse>,
  );

  const { data: dailyData } = useSWR(
    currentOrg && tenantId
      ? `/api/organizations/${currentOrg.id}/analytics/earnings?level=tenant&targetId=${tenantId}&granularity=day&periods=30`
      : null,
    api.get<DailyCallData[]>,
  );

  const { data: analytics } = useSWR(
    currentOrg && tenantId
      ? `/api/organizations/${currentOrg.id}/tenants/${tenantId}/analytics`
      : null,
    api.get<EarningsAnalytics>,
  );

  const chartData = useMemo(() => {
    const dataMap = new Map<string, number>();
    if (dailyData && Array.isArray(dailyData)) {
      dailyData.forEach((d) => dataMap.set(d.period, d.call_count));
    }
    const result = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const period = date.toISOString().slice(0, 10);
      result.push({
        date: period.slice(5),
        calls: dataMap.get(period) ?? 0,
      });
    }
    return result;
  }, [dailyData]);

  const revenueChartData = useMemo(() => {
    const dataMap = new Map<string, number>();
    if (dailyData && Array.isArray(dailyData)) {
      dailyData.forEach((d) => dataMap.set(d.period, d.total));
    }
    const result = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const period = date.toISOString().slice(0, 10);
      result.push({
        date: period.slice(5),
        revenue: dataMap.get(period) ?? 0,
      });
    }
    return result;
  }, [dailyData]);

  const tenant = tenants?.find((t) => t.id === tenantId);

  if (!currentOrg) {
    return (
      <div className="rounded-lg border border-gray-6 bg-gray-2 p-6">
        <h2 className="mb-2 text-lg font-medium text-gray-12">
          No Organization Selected
        </h2>
        <p className="text-sm text-gray-11">
          Select an organization from the sidebar to view proxy details.
        </p>
      </div>
    );
  }

  if (tenantsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
      </div>
    );
  }

  if (!tenant) {
    return (
      <div className="rounded-lg border border-gray-6 bg-gray-2 p-6">
        <h2 className="mb-2 text-lg font-medium text-gray-12">
          Proxy Not Found
        </h2>
        <p className="text-sm text-gray-11">
          The proxy you are looking for does not exist or you do not have
          permission to view it.
        </p>
        <Link
          href="/proxies"
          className="mt-4 inline-flex items-center gap-1 text-sm text-accent-11 hover:underline"
        >
          <ChevronLeftIcon className="h-4 w-4" />
          Back to Proxies
        </Link>
      </div>
    );
  }

  const apiEndpoint = `/api/organizations/${currentOrg.id}/tenants/${tenant.id}`;

  const tabs: { id: TabType; label: string }[] = [
    { id: "overview", label: "Analytics" },
    { id: "endpoints", label: "Endpoints" },
    { id: "settings", label: "Settings" },
  ];

  const handleDeleteProxy = async () => {
    if (!tenant || deleteConfirmation !== tenant.name) return;

    setIsDeleting(true);
    try {
      await api.delete(apiEndpoint);
      setDeleteDialogOpen(false);
      toast({
        title: "Proxy deleted",
        description: `${tenant.name} has been permanently deleted.`,
        variant: "success",
      });
      router.push("/proxies");
    } catch (err) {
      if (err instanceof ApiError && err.data) {
        const data = err.data as { error?: string };
        toast({
          title: "Cannot delete proxy",
          description: data.error ?? "Failed to delete proxy",
          variant: "error",
        });
      } else {
        toast({
          title: "Error",
          description:
            err instanceof Error ? err.message : "Failed to delete proxy",
          variant: "error",
        });
      }
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-gray-11">
        <Link href="/proxies" className="hover:text-gray-12">
          Proxies
        </Link>
        <span>/</span>
        <span className="text-gray-12">{tenant.name}</span>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold text-gray-12">{tenant.name}</h1>
          <div className="flex items-center rounded-lg border border-gray-6 bg-gray-3/50">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <code className="text-sm text-gray-11">
                {getProxyUrl({
                  proxyName: tenant.name,
                  orgSlug: tenant.org_slug,
                })}
              </code>
            </div>
            <button
              onClick={() =>
                void (async () => {
                  const proxyUrl = getProxyUrl({
                    proxyName: tenant.name,
                    orgSlug: tenant.org_slug,
                  });
                  await navigator.clipboard.writeText(proxyUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                  toast({ title: "URL copied to clipboard" });
                })()
              }
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
              href={getProxyUrl({
                proxyName: tenant.name,
                orgSlug: tenant.org_slug,
              })}
              target="_blank"
              rel="noopener noreferrer"
              className="border-l border-gray-6 px-2 py-1.5 text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors rounded-r-lg"
              title="Open in new tab"
            >
              <ExternalLinkIcon className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge tenant={tenant} size="md" />
          {tenant.status === "registered" && (
            <GoLiveButton
              tenant={tenant}
              orgId={currentOrg.id}
              onActivate={() => void mutateTenants()}
            />
          )}
        </div>
      </div>

      <div className="border-b border-gray-6">
        <nav className="-mb-px flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`border-b-2 px-1 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-accent-9 text-gray-12"
                  : "border-transparent text-gray-11 hover:border-gray-6 hover:text-gray-12"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <div>
        {activeTab === "overview" && (
          <div className="space-y-6">
            {(() => {
              const tokenTooltip = buildTokenTooltip(
                analytics?.token_breakdown,
              );
              return (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
                    <p className="text-[12px] text-gray-9">Total Earned</p>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <p
                        className={`text-[15px] font-medium ${getValueColor(analytics?.total_earned)}`}
                      >
                        {formatUSDC(analytics?.total_earned)}
                      </p>
                      {tokenTooltip && (
                        <span
                          className="cursor-help text-gray-9"
                          title={tokenTooltip}
                        >
                          <InfoCircledIcon className="h-3 w-3" />
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
                    <p className="text-[12px] text-gray-9">This Month</p>
                    <div className="mt-1 flex items-baseline gap-2">
                      <p
                        className={`text-[15px] font-medium ${getValueColor(analytics?.current_month_earned)}`}
                      >
                        {formatUSDC(analytics?.current_month_earned)}
                      </p>
                      {tokenTooltip && (
                        <span
                          className="cursor-help text-gray-9"
                          title={tokenTooltip}
                        >
                          <InfoCircledIcon className="h-3 w-3" />
                        </span>
                      )}
                      {formatChange(analytics?.percent_change) !== "-" && (
                        <span
                          className={`text-[12px] font-medium ${getChangeColor(analytics?.percent_change)}`}
                        >
                          {formatChange(analytics?.percent_change)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            <Tabs.Root
              defaultValue="revenue"
              className="rounded-lg border border-gray-6 bg-gray-2 p-6"
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-medium uppercase tracking-wider text-gray-11">
                  Activity{" "}
                  <span className="text-xs font-normal normal-case text-gray-9">
                    Last 30 Days
                  </span>
                </h3>
                <Tabs.List className="flex rounded-md bg-gray-4 p-0.5">
                  <Tabs.Trigger
                    value="revenue"
                    className="rounded px-3 py-1 text-xs font-medium text-gray-11 transition-colors data-[state=active]:bg-gray-6 data-[state=active]:text-white"
                  >
                    Revenue
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="calls"
                    className="rounded px-3 py-1 text-xs font-medium text-gray-11 transition-colors data-[state=active]:bg-gray-6 data-[state=active]:text-white"
                  >
                    Calls
                  </Tabs.Trigger>
                </Tabs.List>
              </div>
              <Tabs.Content value="calls">
                <div className="h-48">
                  {dailyData && dailyData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData}>
                        <XAxis
                          dataKey="date"
                          tick={{ fill: "#888", fontSize: 10 }}
                          tickLine={false}
                          axisLine={{ stroke: "#333" }}
                        />
                        <YAxis
                          tick={{ fill: "#888", fontSize: 10 }}
                          tickLine={false}
                          axisLine={{ stroke: "#333" }}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "6px",
                          }}
                          labelStyle={{ color: "#888" }}
                          cursor={{ fill: "rgba(234, 134, 42, 0.15)" }}
                        />
                        <Bar
                          dataKey="calls"
                          fill="#ea862a"
                          radius={[2, 2, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-gray-9">No activity yet</p>
                    </div>
                  )}
                </div>
              </Tabs.Content>
              <Tabs.Content value="revenue">
                <div className="h-48">
                  {dailyData && dailyData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={revenueChartData}>
                        <XAxis
                          dataKey="date"
                          tick={{ fill: "#888", fontSize: 10 }}
                          tickLine={false}
                          axisLine={{ stroke: "#333" }}
                        />
                        <YAxis
                          tick={{ fill: "#888", fontSize: 10 }}
                          tickLine={false}
                          axisLine={{ stroke: "#333" }}
                          tickFormatter={(value) => formatUSDC(value)}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "6px",
                          }}
                          labelStyle={{ color: "#888" }}
                          formatter={(value) => [
                            formatUSDC(value as number),
                            "Revenue",
                          ]}
                          cursor={{ fill: "rgba(234, 134, 42, 0.15)" }}
                        />
                        <Bar
                          dataKey="revenue"
                          fill="#ea862a"
                          radius={[2, 2, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-gray-9">No revenue yet</p>
                    </div>
                  )}
                </div>
              </Tabs.Content>
            </Tabs.Root>
          </div>
        )}

        {activeTab === "endpoints" && (
          <EndpointsTab
            tenantId={tenantId}
            orgId={currentOrg.id}
            defaultPrice={tenant.default_price}
            defaultScheme={tenant.default_scheme}
            hasOpenApiSpec={specData?.hasSpec ?? false}
            onSpecChange={() => void mutateSpec()}
            onDefaultsChange={() => void mutateTenants()}
          />
        )}

        {activeTab === "settings" && (
          <div className="space-y-6">
            <div className="rounded-lg border border-gray-6 bg-gray-2 p-6">
              <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-gray-11">
                Proxy Settings
              </h3>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-gray-11">Active</dt>
                  <dd className="mt-1">
                    <InlineActiveToggle
                      tenantId={tenant.id}
                      tenantName={tenant.name}
                      isActive={tenant.is_active}
                      onUpdate={() => void mutateTenants()}
                      apiEndpoint={apiEndpoint}
                      disabled={tenant.status === "registered"}
                      disabledTooltip="Go live to enable this setting"
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-11">Wallet</dt>
                  <dd className="mt-1">
                    <InlineWalletSelect
                      tenantName={tenant.name}
                      organizationId={currentOrg.id}
                      currentWalletId={tenant.wallet_id}
                      currentWalletName={tenant.wallet_name}
                      apiEndpoint={apiEndpoint}
                      onUpdate={() => void mutateTenants()}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-11">Backend URL</dt>
                  <dd className="mt-1">
                    <InlineUrlEdit
                      tenantId={tenant.id}
                      tenantName={tenant.name}
                      backendUrl={tenant.backend_url}
                      onUpdate={() => void mutateTenants()}
                      apiEndpoint={apiEndpoint}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-11">Backend Auth Header</dt>
                  <dd className="mt-1">
                    <InlineAuthEdit
                      tenantId={tenant.id}
                      tenantName={tenant.name}
                      authHeader={tenant.upstream_auth_header}
                      authValue={tenant.upstream_auth_value}
                      onUpdate={() => void mutateTenants()}
                      apiEndpoint={apiEndpoint}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-11">Default Price</dt>
                  <dd className="mt-1">
                    {tenant.default_scheme === "flex" ? (
                      <button
                        type="button"
                        onClick={() => setRootPricingOpen(true)}
                        className="group flex items-center gap-1 rounded bg-gray-4 px-2 py-1 text-xs text-gray-11 hover:bg-gray-5"
                      >
                        Dynamic
                        <Pencil1Icon className="h-3 w-3 opacity-50 group-hover:opacity-100" />
                      </button>
                    ) : (
                      <InlinePriceEdit
                        priceMicro={tenant.default_price}
                        onUpdate={() => void mutateTenants()}
                        apiEndpoint={apiEndpoint}
                      />
                    )}
                  </dd>
                </div>
                <div className="col-span-2">
                  <TokenPricesSection
                    tenantId={tenant.id}
                    onUpdated={() => void mutateTenants()}
                  />
                </div>
                <div>
                  <dt className="text-gray-11">Default Scheme</dt>
                  <dd className="mt-1">
                    <InlineSchemeEdit
                      scheme={tenant.default_scheme}
                      onUpdate={() => void mutateTenants()}
                      apiEndpoint={apiEndpoint}
                      onFullEditRequired={() => setRootPricingOpen(true)}
                    />
                  </dd>
                </div>
              </dl>
            </div>

            <section className="rounded-lg border border-red-900/50 bg-red-950/20 p-6">
              <h3 className="mb-2 text-lg font-medium text-red-400">
                Danger Zone
              </h3>
              <p className="mb-4 text-sm text-gray-11">
                Once you delete a proxy, there is no going back. All endpoints
                and transaction history will be permanently deleted.
              </p>
              <button
                onClick={() => setDeleteDialogOpen(true)}
                className="rounded-md border border-red-800 bg-red-900/30 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-900/50"
              >
                Delete Proxy
              </button>
            </section>
          </div>
        )}
      </div>

      <RootPricingRulesDialog
        open={rootPricingOpen}
        onOpenChange={setRootPricingOpen}
        tenantId={tenant.id}
        defaultSchemeApiEndpoint={apiEndpoint}
        onSaved={() => void mutateTenants()}
      />

      <Dialog.Root
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) setDeleteConfirmation("");
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-1 p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <Dialog.Title className="text-lg font-semibold text-gray-12">
                Delete Proxy
              </Dialog.Title>
              <Dialog.Close className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12">
                <Cross2Icon className="h-4 w-4" />
              </Dialog.Close>
            </div>

            <div className="space-y-4">
              <p className="text-sm text-gray-11">
                This action cannot be undone. This will permanently delete{" "}
                <span className="font-medium text-gray-12">{tenant.name}</span>{" "}
                and all associated endpoints.
              </p>

              <p className="text-sm text-gray-11">
                Please type{" "}
                <span className="font-mono text-gray-12">{tenant.name}</span> to
                confirm.
              </p>

              <input
                type="text"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
                placeholder={tenant.name}
                className="w-full rounded-md border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 placeholder-gray-9 focus:border-red-800 focus:outline-none focus:ring-1 focus:ring-red-800"
              />

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setDeleteDialogOpen(false)}
                  className="rounded-md border border-gray-6 px-4 py-2 text-sm text-gray-11 hover:bg-gray-3"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleDeleteProxy()}
                  disabled={isDeleting || deleteConfirmation !== tenant.name}
                  className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  {isDeleting ? "Deleting..." : "Delete Proxy"}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
