"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { api } from "@/lib/api/client";
import {
  Link2Icon,
  ExclamationTriangleIcon,
  TrashIcon,
  Pencil1Icon,
} from "@radix-ui/react-icons";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AdminEditEndpointDialog } from "./admin-edit-endpoint-dialog";
import { RootPricingRulesDialog } from "@/components/proxy-endpoints/root-pricing-rules-dialog";
import { InlinePriceEdit } from "@/components/shared/inline-price-edit";
import { InlineSchemeEdit } from "@/components/shared/inline-scheme-edit";
import { useToast } from "@/components/ui/toast";

interface Endpoint {
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
}

interface Tenant {
  id: number;
  name: string;
  backend_url: string;
  default_price: number;
  default_scheme: string;
  is_active: boolean;
  status: string;
  wallet_id: number | null;
  wallet_funding_status: string | null;
}

interface OrgEndpointsTableProps {
  tenants: Tenant[];
  onUpdate?: () => void;
}

interface EndpointWithTenant extends Endpoint {
  tenant: Tenant;
}

// Fetcher that fetches endpoints for all tenants
async function fetchAllEndpoints(
  tenantIds: number[],
): Promise<Record<number, Endpoint[]>> {
  const results = await Promise.all(
    tenantIds.map((id) =>
      api.get<Endpoint[]>(`/api/admin/tenants/${id}/endpoints`),
    ),
  );
  const endpointsByTenant: Record<number, Endpoint[]> = {};
  tenantIds.forEach((id, index) => {
    endpointsByTenant[id] = results[index];
  });
  return endpointsByTenant;
}

export function OrgEndpointsTable({
  tenants,
  onUpdate,
}: OrgEndpointsTableProps) {
  const { toast } = useToast();
  const [endpointToDelete, setEndpointToDelete] =
    useState<EndpointWithTenant | null>(null);
  const [editingEndpoint, setEditingEndpoint] =
    useState<EndpointWithTenant | null>(null);
  const [editingInitialScheme, setEditingInitialScheme] = useState<
    string | undefined
  >(undefined);
  const [rootPricingTenant, setRootPricingTenant] = useState<Tenant | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  // Create a stable key from tenant IDs
  const tenantIds = useMemo(() => tenants.map((t) => t.id), [tenants]);
  const cacheKey =
    tenantIds.length > 0 ? `endpoints-${tenantIds.join(",")}` : null;

  const {
    data: endpointsByTenant,
    isLoading,
    mutate,
  } = useSWR(cacheKey, () => fetchAllEndpoints(tenantIds), {
    refreshInterval: 5000,
  });

  // Combine all endpoints with their tenant info
  const allEndpoints = useMemo(() => {
    if (!endpointsByTenant) return [];
    const result: EndpointWithTenant[] = [];
    tenants.forEach((tenant) => {
      const endpoints = endpointsByTenant[tenant.id] ?? [];
      endpoints.forEach((endpoint) => {
        result.push({ ...endpoint, tenant });
      });
    });
    // Sort by tenant name, then by priority
    result.sort((a, b) => {
      const tenantCompare = a.tenant.name.localeCompare(b.tenant.name);
      if (tenantCompare !== 0) return tenantCompare;
      return a.priority - b.priority;
    });
    return result;
  }, [tenants, endpointsByTenant]);

  const handleDelete = async () => {
    if (!endpointToDelete) return;

    setIsDeleting(true);
    try {
      await api.delete(
        `/api/admin/tenants/${endpointToDelete.tenant_id}/endpoints/${endpointToDelete.id}`,
      );
      toast({
        title: "Endpoint deleted",
        variant: "success",
      });
      void mutate();
      setEndpointToDelete(null);
    } catch {
      toast({
        title: "Failed to delete endpoint",
        variant: "error",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const getLineageStatus = (endpoint: Endpoint) => {
    if (
      !endpoint.openapi_source_paths ||
      endpoint.openapi_source_paths.length === 0
    ) {
      return { hasLineage: false, paths: [] as string[] };
    }
    return { hasLineage: true, paths: endpoint.openapi_source_paths };
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px]">
          <thead className="bg-gray-3">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-11">
                Tenant
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-11">
                Path
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium text-gray-11">
                Price
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium text-gray-11">
                Scheme
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium text-gray-11">
                Lineage
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium text-gray-11">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-6 bg-gray-2">
            {/* Default pricing rows for each tenant */}
            {tenants.map((tenant) => (
              <tr key={`default-${tenant.id}`} className="bg-gray-3/50">
                <td className="px-4 py-3">
                  <span className="text-sm font-medium text-gray-12">
                    {tenant.name}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <code className="text-xs text-accent-11">/</code>
                    <span className="text-[10px] text-gray-11">(default)</span>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <div className="flex items-center gap-2">
                    {tenant.default_scheme === "flex" ? (
                      <button
                        type="button"
                        onClick={() => setRootPricingTenant(tenant)}
                        className="group flex items-center gap-1 rounded bg-gray-4 px-2 py-1 text-xs text-gray-11 hover:bg-gray-5"
                      >
                        Dynamic
                        <Pencil1Icon className="h-3 w-3 opacity-50 group-hover:opacity-100" />
                      </button>
                    ) : (
                      <>
                        <InlinePriceEdit
                          priceMicro={tenant.default_price}
                          onUpdate={() => {
                            void mutate();
                            onUpdate?.();
                          }}
                          apiEndpoint={`/api/admin/tenants/${tenant.id}`}
                          fieldName="default_price"
                          label="Default Price"
                        />
                        {tenant.default_price === 0 && (
                          <span className="rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400 border border-green-800">
                            Free
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <InlineSchemeEdit
                    scheme={tenant.default_scheme}
                    onUpdate={() => {
                      void mutate();
                      onUpdate?.();
                    }}
                    apiEndpoint={`/api/admin/tenants/${tenant.id}`}
                    fieldName="default_scheme"
                    label="Default Scheme"
                    onFullEditRequired={() => setRootPricingTenant(tenant)}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span className="text-[10px] text-gray-11">-</span>
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span className="text-[10px] text-gray-11">-</span>
                </td>
              </tr>
            ))}
            {/* Endpoint rows */}
            {allEndpoints.map((endpoint) => {
              const lineage = getLineageStatus(endpoint);
              const effectiveScheme =
                endpoint.scheme ?? endpoint.tenant.default_scheme;
              return (
                <tr key={endpoint.id} className="hover:bg-gray-3">
                  <td className="px-4 py-3">
                    <span className="text-sm text-gray-11">
                      {endpoint.tenant.name}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col">
                      <code className="text-xs text-gray-12">
                        {endpoint.path ?? endpoint.path_pattern}
                      </code>
                      {endpoint.description && (
                        <span className="text-[10px] text-gray-11">
                          {endpoint.description}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <div className="flex items-center gap-2">
                      {effectiveScheme === "flex" ? (
                        <button
                          type="button"
                          onClick={() => setEditingEndpoint(endpoint)}
                          className="group flex items-center gap-1 rounded bg-gray-4 px-2 py-1 text-xs text-gray-11 hover:bg-gray-5"
                        >
                          Dynamic
                          <Pencil1Icon className="h-3 w-3 opacity-50 group-hover:opacity-100" />
                        </button>
                      ) : (
                        <>
                          <InlinePriceEdit
                            priceMicro={
                              endpoint.price ?? endpoint.tenant.default_price
                            }
                            defaultPriceMicro={endpoint.tenant.default_price}
                            onUpdate={() => void mutate()}
                            apiEndpoint={`/api/admin/tenants/${endpoint.tenant_id}/endpoints/${endpoint.id}`}
                            fieldName="price"
                            label="Price"
                          />
                          {(endpoint.price ?? endpoint.tenant.default_price) ===
                            0 && (
                            <span className="rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400 border border-green-800">
                              Free
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <InlineSchemeEdit
                      scheme={endpoint.scheme ?? endpoint.tenant.default_scheme}
                      defaultScheme={endpoint.tenant.default_scheme}
                      onUpdate={() => void mutate()}
                      apiEndpoint={`/api/admin/tenants/${endpoint.tenant_id}/endpoints/${endpoint.id}`}
                      fieldName="scheme"
                      label="Scheme"
                      onFullEditRequired={(selectedScheme) => {
                        setEditingInitialScheme(selectedScheme);
                        setEditingEndpoint(endpoint);
                      }}
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {lineage.hasLineage ? (
                      <Tooltip.Provider delayDuration={100}>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <div className="flex items-center gap-1 text-green-400 cursor-pointer">
                              <Link2Icon className="h-3 w-3" />
                              <span className="text-[10px]">
                                {lineage.paths.length} path
                                {lineage.paths.length !== 1 ? "s" : ""}
                              </span>
                            </div>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="w-64 rounded-md border border-gray-6 bg-gray-2 p-2 shadow-lg"
                              sideOffset={5}
                            >
                              <p className="mb-1 text-xs font-medium text-gray-11">
                                OpenAPI Source Paths:
                              </p>
                              <ul className="space-y-0.5">
                                {lineage.paths.map((path, i) => (
                                  <li
                                    key={i}
                                    className="text-xs text-gray-12 font-mono"
                                  >
                                    {path}
                                  </li>
                                ))}
                              </ul>
                              <Tooltip.Arrow className="fill-gray-6" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      </Tooltip.Provider>
                    ) : (
                      <Tooltip.Provider delayDuration={100}>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <div className="flex items-center gap-1 text-yellow-400 cursor-pointer">
                              <ExclamationTriangleIcon className="h-3 w-3" />
                              <span className="text-[10px]">Orphan</span>
                            </div>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="max-w-xs rounded-md border border-gray-6 bg-gray-2 p-2 shadow-lg"
                              sideOffset={5}
                            >
                              <p className="text-xs text-gray-11">
                                Not linked to any OpenAPI spec paths.
                              </p>
                              <Tooltip.Arrow className="fill-gray-6" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      </Tooltip.Provider>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditingEndpoint(endpoint)}
                        className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
                        title="Edit endpoint"
                      >
                        <Pencil1Icon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setEndpointToDelete(endpoint)}
                        className="rounded p-1 text-gray-11 hover:bg-red-900/30 hover:text-red-400"
                        title="Delete endpoint"
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editingEndpoint && (
        <AdminEditEndpointDialog
          endpoint={editingEndpoint}
          tenantId={editingEndpoint.tenant_id}
          defaultPrice={editingEndpoint.tenant.default_price}
          defaultScheme={editingEndpoint.tenant.default_scheme}
          initialScheme={editingInitialScheme}
          onClose={() => {
            setEditingEndpoint(null);
            setEditingInitialScheme(undefined);
          }}
          onSuccess={() => {
            setEditingEndpoint(null);
            setEditingInitialScheme(undefined);
            void mutate();
          }}
        />
      )}

      {rootPricingTenant && (
        <RootPricingRulesDialog
          open={!!rootPricingTenant}
          onOpenChange={(open) => {
            if (!open) setRootPricingTenant(null);
          }}
          tenantId={rootPricingTenant.id}
          defaultSchemeApiEndpoint={`/api/admin/tenants/${rootPricingTenant.id}`}
          onSaved={() => {
            void mutate();
            onUpdate?.();
          }}
        />
      )}

      <AlertDialog.Root
        open={!!endpointToDelete}
        onOpenChange={(open) => !open && setEndpointToDelete(null)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-lg">
            <AlertDialog.Title className="text-lg font-semibold text-gray-12">
              Delete Endpoint
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-gray-11">
              Are you sure you want to delete this endpoint?
              <code className="mt-2 block rounded bg-gray-4 px-2 py-1 text-sm text-gray-12">
                {endpointToDelete?.path ?? endpointToDelete?.path_pattern}
              </code>
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <button className="rounded-md px-3 py-2 text-sm font-medium text-gray-11 hover:bg-gray-4 hover:text-gray-12">
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <button
                onClick={() => void handleDelete()}
                disabled={isDeleting}
                className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
