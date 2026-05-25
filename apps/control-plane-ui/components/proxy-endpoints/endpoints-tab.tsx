"use client";

import { useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api/client";
import {
  PlusIcon,
  UploadIcon,
  DownloadIcon,
  Link2Icon,
  ExclamationTriangleIcon,
  TrashIcon,
  Pencil1Icon,
} from "@radix-ui/react-icons";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { OpenApiImportDialog } from "./openapi-import-dialog";
import { OpenApiExportDialog } from "./openapi-export-dialog";
import { AddEndpointDialog } from "./add-endpoint-dialog";
import { EditEndpointPopover } from "./edit-endpoint-popover";
import { RootPricingRulesDialog } from "./root-pricing-rules-dialog";
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

interface EndpointsTabProps {
  tenantId: number;
  orgId: number;
  defaultPrice: number;
  defaultScheme: string;
  hasOpenApiSpec: boolean;
  onSpecChange: () => void;
  onDefaultsChange: () => void;
}

export function EndpointsTab({
  tenantId,
  orgId,
  defaultPrice,
  defaultScheme,
  hasOpenApiSpec,
  onSpecChange,
  onDefaultsChange,
}: EndpointsTabProps) {
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [rootPricingOpen, setRootPricingOpen] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<Endpoint | null>(null);
  const [editingInitialScheme, setEditingInitialScheme] = useState<
    string | undefined
  >(undefined);
  const [endpointToDelete, setEndpointToDelete] = useState<Endpoint | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const { toast } = useToast();

  const {
    data: endpoints,
    isLoading,
    mutate,
  } = useSWR(
    tenantId ? `/api/tenants/${tenantId}/endpoints` : null,
    api.get<Endpoint[]>,
    { refreshInterval: 5000 },
  );

  const handleDelete = async () => {
    if (!endpointToDelete) return;

    setIsDeleting(true);
    try {
      await api.delete(
        `/api/tenants/${tenantId}/endpoints/${endpointToDelete.id}`,
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
      return { hasLineage: false, paths: [] };
    }
    return { hasLineage: true, paths: endpoint.openapi_source_paths };
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-gray-12">Endpoints</h3>
          <p className="text-sm text-gray-11">
            Configure pricing for API paths
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExportDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-6 bg-gray-3 px-3 py-1.5 text-sm font-medium text-gray-12 hover:bg-gray-4"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
            Export OpenAPI
          </button>
          <button
            onClick={() => setImportDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-6 bg-gray-3 px-3 py-1.5 text-sm font-medium text-gray-12 hover:bg-gray-4"
          >
            <UploadIcon className="h-3.5 w-3.5" />
            Import OpenAPI
          </button>
          <button
            onClick={() => setAddDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90"
          >
            <PlusIcon className="h-4 w-4" />
            Add Endpoint
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
        </div>
      ) : (
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
              {endpoints?.map((endpoint) => {
                const lineage = getLineageStatus(endpoint);
                const effectiveScheme = endpoint.scheme ?? defaultScheme;
                return (
                  <tr key={endpoint.id} className="hover:bg-gray-3">
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <code className="text-sm text-gray-12">
                          {endpoint.path ?? endpoint.path_pattern}
                        </code>
                        {endpoint.description && (
                          <span className="text-xs text-gray-11">
                            {endpoint.description}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {endpoint.tags?.length > 0 ? (
                          endpoint.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded bg-gray-4 px-1.5 py-0.5 text-[10px] font-medium text-gray-11"
                            >
                              {tag}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-gray-9">-</span>
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
                          <InlinePriceEdit
                            priceMicro={endpoint.price ?? defaultPrice}
                            defaultPriceMicro={defaultPrice}
                            onUpdate={() => void mutate()}
                            apiEndpoint={`/api/tenants/${tenantId}/endpoints/${endpoint.id}`}
                            fieldName="price"
                            label="Price"
                          />
                        )}
                        {effectiveScheme !== "flex" &&
                          (endpoint.price ?? defaultPrice) === 0 && (
                            <span className="rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400 border border-green-800">
                              Free
                            </span>
                          )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <InlineSchemeEdit
                        scheme={endpoint.scheme ?? defaultScheme}
                        defaultScheme={defaultScheme}
                        onUpdate={() => void mutate()}
                        apiEndpoint={`/api/tenants/${tenantId}/endpoints/${endpoint.id}`}
                        fieldName="scheme"
                        label="Scheme"
                        onFullEditRequired={(selectedScheme) => {
                          setEditingInitialScheme(selectedScheme);
                          setEditingEndpoint(endpoint);
                        }}
                      />
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
                                    Manually created or the source spec was
                                    removed.
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
                          onClick={() => setEditingEndpoint(endpoint)}
                          className="rounded p-1.5 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
                          title="Edit endpoint"
                        >
                          <Pencil1Icon className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setEndpointToDelete(endpoint)}
                          className="rounded p-1.5 text-gray-11 hover:bg-red-900/30 hover:text-red-400"
                          title="Delete endpoint"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-gray-3/50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <code className="text-sm text-accent-11">/</code>
                    <span className="text-xs text-gray-11">(catch-all)</span>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span className="text-xs text-gray-11">-</span>
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <div className="flex items-center gap-2">
                    {defaultScheme === "flex" ? (
                      <button
                        type="button"
                        onClick={() => setRootPricingOpen(true)}
                        className="group flex items-center gap-1 rounded bg-gray-4 px-2 py-1 text-xs text-gray-11 hover:bg-gray-5"
                      >
                        Dynamic
                        <Pencil1Icon className="h-3 w-3 opacity-50 group-hover:opacity-100" />
                      </button>
                    ) : (
                      <>
                        <InlinePriceEdit
                          priceMicro={defaultPrice}
                          onUpdate={onDefaultsChange}
                          apiEndpoint={`/api/organizations/${orgId}/tenants/${tenantId}`}
                          fieldName="default_price"
                          label="Default Price"
                        />
                        {defaultPrice === 0 && (
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
                    scheme={defaultScheme}
                    onUpdate={onDefaultsChange}
                    apiEndpoint={`/api/organizations/${orgId}/tenants/${tenantId}`}
                    fieldName="default_scheme"
                    label="Default Scheme"
                    onFullEditRequired={() => setRootPricingOpen(true)}
                  />
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
            </tbody>
          </table>
        </div>
      )}

      <OpenApiImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        tenantId={tenantId}
        defaultScheme={defaultScheme}
        onSuccess={() => {
          void mutate();
          onSpecChange();
        }}
      />

      <OpenApiExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        tenantId={tenantId}
      />

      <AddEndpointDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        tenantId={tenantId}
        hasOpenApiSpec={hasOpenApiSpec}
        onSuccess={() => void mutate()}
        defaultPrice={defaultPrice}
        defaultScheme={defaultScheme}
      />

      <RootPricingRulesDialog
        open={rootPricingOpen}
        onOpenChange={setRootPricingOpen}
        tenantId={tenantId}
        defaultSchemeApiEndpoint={`/api/organizations/${orgId}/tenants/${tenantId}`}
        onSaved={onDefaultsChange}
      />

      {editingEndpoint && (
        <EditEndpointPopover
          endpoint={editingEndpoint}
          tenantId={tenantId}
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
