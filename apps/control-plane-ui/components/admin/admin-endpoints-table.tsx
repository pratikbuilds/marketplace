"use client";

import { useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api/client";
import {
  Link2Icon,
  ExclamationTriangleIcon,
  TrashIcon,
  Pencil1Icon,
} from "@radix-ui/react-icons";
import { AdminEditEndpointDialog } from "./admin-edit-endpoint-dialog";
import { RootPricingRulesDialog } from "@/components/proxy-endpoints/root-pricing-rules-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { InlinePriceEdit } from "@/components/shared/inline-price-edit";
import { InlineSchemeEdit } from "@/components/shared/inline-scheme-edit";
import { InlineTagsEdit } from "@/components/admin/inline-tags-edit";
import { useToast } from "@/components/ui/toast";
import {
  type EarningsAnalytics,
  formatUSDC,
  getValueColor,
  getChangeColor,
  formatChange,
} from "@/lib/analytics";

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

interface OpenApiSpecResponse {
  spec: unknown;
  hasSpec: boolean;
}

interface AdminEndpointsTableProps {
  tenantId: number;
  defaultPrice: number;
  defaultScheme: string;
  enabled: boolean;
  onDefaultsChange?: () => void;
}

export function AdminEndpointsTable({
  tenantId,
  defaultPrice,
  defaultScheme,
  enabled,
  onDefaultsChange,
}: AdminEndpointsTableProps) {
  const { toast } = useToast();
  const [endpointToDelete, setEndpointToDelete] = useState<Endpoint | null>(
    null,
  );
  const [editingEndpoint, setEditingEndpoint] = useState<Endpoint | null>(null);
  const [editingInitialScheme, setEditingInitialScheme] = useState<
    string | undefined
  >(undefined);
  const [rootPricingOpen, setRootPricingOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const {
    data: endpoints,
    isLoading,
    mutate,
  } = useSWR(
    enabled ? `/api/admin/tenants/${tenantId}/endpoints` : null,
    api.get<Endpoint[]>,
    { refreshInterval: 5000 },
  );

  const { data: specData } = useSWR(
    enabled ? `/api/admin/tenants/${tenantId}/openapi/spec` : null,
    api.get<OpenApiSpecResponse>,
  );

  const hasOpenApiSpec = specData?.hasSpec ?? false;

  const handleDelete = async () => {
    if (!endpointToDelete) return;

    setIsDeleting(true);
    try {
      await api.delete(
        `/api/admin/tenants/${tenantId}/endpoints/${endpointToDelete.id}`,
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

  if (!enabled) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="overflow-x-auto rounded-lg border border-gray-6">
        <table className="w-full min-w-[700px]">
          <thead className="bg-gray-3">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                Path
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-left text-sm font-medium text-gray-11">
                Tags
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-left text-sm font-medium text-gray-11">
                Price
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-left text-sm font-medium text-gray-11">
                Scheme
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-11">
                Earned
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-11">
                This Month
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-11">
                Change
              </th>
              <th className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-11">
                Calls
              </th>
              {hasOpenApiSpec && (
                <th className="whitespace-nowrap px-4 py-3 text-left text-sm font-medium text-gray-11">
                  Lineage
                </th>
              )}
              <th className="whitespace-nowrap px-4 py-3 text-left text-sm font-medium text-gray-11">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-6 bg-gray-2">
            {endpoints?.map((endpoint) => (
              <EndpointRow
                key={endpoint.id}
                endpoint={endpoint}
                tenantId={tenantId}
                defaultPrice={defaultPrice}
                defaultScheme={defaultScheme}
                hasOpenApiSpec={hasOpenApiSpec}
                onUpdate={() => void mutate()}
                onEdit={() => setEditingEndpoint(endpoint)}
                onEditWithScheme={(selectedScheme) => {
                  setEditingInitialScheme(selectedScheme);
                  setEditingEndpoint(endpoint);
                }}
                onDelete={() => setEndpointToDelete(endpoint)}
              />
            ))}
            <DefaultRow
              tenantId={tenantId}
              defaultPrice={defaultPrice}
              defaultScheme={defaultScheme}
              hasOpenApiSpec={hasOpenApiSpec}
              onUpdate={() => {
                void mutate();
                onDefaultsChange?.();
              }}
              onEditRootPricing={() => setRootPricingOpen(true)}
            />
          </tbody>
        </table>
      </div>

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

      {editingEndpoint && (
        <AdminEditEndpointDialog
          endpoint={editingEndpoint}
          tenantId={tenantId}
          defaultPrice={defaultPrice}
          defaultScheme={defaultScheme}
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

      <RootPricingRulesDialog
        open={rootPricingOpen}
        onOpenChange={setRootPricingOpen}
        tenantId={tenantId}
        defaultSchemeApiEndpoint={`/api/admin/tenants/${tenantId}`}
        onSaved={() => {
          void mutate();
          onDefaultsChange?.();
        }}
      />
    </div>
  );
}

function EndpointRow({
  endpoint,
  tenantId,
  defaultPrice,
  defaultScheme,
  hasOpenApiSpec,
  onUpdate,
  onEdit,
  onEditWithScheme,
  onDelete,
}: {
  endpoint: Endpoint;
  tenantId: number;
  defaultPrice: number;
  defaultScheme: string;
  hasOpenApiSpec: boolean;
  onUpdate: () => void;
  onEdit: () => void;
  onEditWithScheme: (scheme: string) => void;
  onDelete: () => void;
}) {
  const { data: analytics, isLoading } = useSWR(
    `/api/admin/tenants/${tenantId}/endpoints/${endpoint.id}/analytics`,
    api.get<EarningsAnalytics>,
  );

  const lineage = {
    hasLineage:
      endpoint.openapi_source_paths && endpoint.openapi_source_paths.length > 0,
    paths: endpoint.openapi_source_paths ?? [],
  };
  const effectiveScheme = endpoint.scheme ?? defaultScheme;

  return (
    <tr className="hover:bg-gray-3">
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <code className="inline-block w-fit rounded bg-accent-4 px-1.5 py-0.5 text-xs text-accent-11">
            {endpoint.path ?? endpoint.path_pattern}
          </code>
          {endpoint.description && (
            <span className="text-xs text-gray-11">{endpoint.description}</span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <InlineTagsEdit
          tags={endpoint.tags ?? []}
          onUpdate={onUpdate}
          apiEndpoint={`/api/admin/tenants/${tenantId}/endpoints/${endpoint.id}`}
          label={endpoint.path ?? endpoint.path_pattern}
        />
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <div className="flex items-center gap-2">
          {effectiveScheme === "flex" ? (
            <button
              type="button"
              onClick={onEdit}
              className="group flex items-center gap-1 rounded bg-gray-4 px-2 py-1 text-xs text-gray-11 hover:bg-gray-5"
            >
              Dynamic
              <Pencil1Icon className="h-3 w-3 opacity-50 group-hover:opacity-100" />
            </button>
          ) : (
            <InlinePriceEdit
              priceMicro={endpoint.price ?? defaultPrice}
              defaultPriceMicro={defaultPrice}
              onUpdate={onUpdate}
              apiEndpoint={`/api/admin/tenants/${tenantId}/endpoints/${endpoint.id}`}
              fieldName="price"
              label="Price"
            />
          )}
          {effectiveScheme !== "flex" &&
            (endpoint.price ?? defaultPrice) === 0 && (
              <span className="rounded bg-green-900/50 px-1.5 py-0.5 text-xs font-medium text-green-400 border border-green-800">
                Free
              </span>
            )}
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <InlineSchemeEdit
          scheme={endpoint.scheme ?? defaultScheme}
          defaultScheme={defaultScheme}
          onUpdate={onUpdate}
          apiEndpoint={`/api/admin/tenants/${tenantId}/endpoints/${endpoint.id}`}
          fieldName="scheme"
          label="Scheme"
          onFullEditRequired={onEditWithScheme}
        />
      </td>
      <td
        className={`whitespace-nowrap px-4 py-3 text-right text-sm ${isLoading ? "text-gray-9" : getValueColor(analytics?.total_earned)}`}
      >
        {isLoading ? "..." : formatUSDC(analytics?.total_earned)}
      </td>
      <td
        className={`whitespace-nowrap px-4 py-3 text-right text-sm ${isLoading ? "text-gray-9" : getValueColor(analytics?.current_month_earned)}`}
      >
        {isLoading ? "..." : formatUSDC(analytics?.current_month_earned)}
      </td>
      <td
        className={`whitespace-nowrap px-4 py-3 text-right text-sm ${isLoading ? "text-gray-9" : getChangeColor(analytics?.percent_change)}`}
      >
        {isLoading ? "..." : formatChange(analytics?.percent_change)}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-white">
        {isLoading
          ? "..."
          : (analytics?.total_transactions ?? 0).toLocaleString()}
      </td>
      {hasOpenApiSpec && (
        <td className="whitespace-nowrap px-4 py-3">
          {lineage.hasLineage ? (
            <Tooltip.Provider delayDuration={100}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <div className="flex items-center gap-1 text-green-400 cursor-pointer">
                    <Link2Icon className="h-4 w-4" />
                    <span className="text-xs">
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
                        <li key={i} className="text-xs text-gray-12 font-mono">
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
                    <ExclamationTriangleIcon className="h-4 w-4" />
                    <span className="text-xs">Orphan</span>
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
      )}
      <td className="whitespace-nowrap px-4 py-3">
        <div className="flex items-center gap-1">
          <button
            onClick={onEdit}
            className="rounded p-1.5 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
            title="Edit endpoint"
          >
            <Pencil1Icon className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
            className="rounded p-1.5 text-gray-11 hover:bg-red-900/30 hover:text-red-400"
            title="Delete endpoint"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function DefaultRow({
  tenantId,
  defaultPrice,
  defaultScheme,
  hasOpenApiSpec,
  onUpdate,
  onEditRootPricing,
}: {
  tenantId: number;
  defaultPrice: number;
  defaultScheme: string;
  hasOpenApiSpec: boolean;
  onUpdate: () => void;
  onEditRootPricing: () => void;
}) {
  const { data: analytics, isLoading } = useSWR(
    `/api/admin/tenants/${tenantId}/catch-all/analytics`,
    api.get<EarningsAnalytics>,
  );

  return (
    <tr className="bg-gray-3/50">
      <td className="px-4 py-3">
        <code className="rounded bg-accent-4 px-1.5 py-0.5 text-xs text-accent-11">
          /
        </code>
        <span className="ml-2 text-xs text-gray-11">(default)</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <span className="text-xs text-gray-11">-</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <div className="flex items-center gap-2">
          {defaultScheme === "flex" ? (
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
              <InlinePriceEdit
                priceMicro={defaultPrice}
                onUpdate={onUpdate}
                apiEndpoint={`/api/admin/tenants/${tenantId}`}
                fieldName="default_price"
                label="Default Price"
              />
              {defaultPrice === 0 && (
                <span className="rounded bg-green-900/50 px-1.5 py-0.5 text-xs font-medium text-green-400 border border-green-800">
                  Free
                </span>
              )}
            </>
          )}
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <InlineSchemeEdit
          scheme={defaultScheme}
          onUpdate={onUpdate}
          apiEndpoint={`/api/admin/tenants/${tenantId}`}
          fieldName="default_scheme"
          label="Default Scheme"
          onFullEditRequired={onEditRootPricing}
        />
      </td>
      <td
        className={`whitespace-nowrap px-4 py-3 text-right text-sm ${isLoading ? "text-gray-9" : getValueColor(analytics?.total_earned)}`}
      >
        {isLoading ? "..." : formatUSDC(analytics?.total_earned)}
      </td>
      <td
        className={`whitespace-nowrap px-4 py-3 text-right text-sm ${isLoading ? "text-gray-9" : getValueColor(analytics?.current_month_earned)}`}
      >
        {isLoading ? "..." : formatUSDC(analytics?.current_month_earned)}
      </td>
      <td
        className={`whitespace-nowrap px-4 py-3 text-right text-sm ${isLoading ? "text-gray-9" : getChangeColor(analytics?.percent_change)}`}
      >
        {isLoading ? "..." : formatChange(analytics?.percent_change)}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-white">
        {isLoading
          ? "..."
          : (analytics?.total_transactions ?? 0).toLocaleString()}
      </td>
      {hasOpenApiSpec && (
        <td className="whitespace-nowrap px-4 py-3">
          <span className="text-xs text-gray-11">-</span>
        </td>
      )}
      <td className="whitespace-nowrap px-4 py-3">
        <span className="text-xs text-gray-11">-</span>
      </td>
    </tr>
  );
}
