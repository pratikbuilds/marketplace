"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  PlusIcon,
  ExclamationTriangleIcon,
  TrashIcon,
  Cross2Icon,
  CopyIcon,
  ExternalLinkIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MagnifyingGlassIcon,
} from "@radix-ui/react-icons";
import * as Dialog from "@radix-ui/react-dialog";
import { api, ApiError } from "@/lib/api/client";
import { StatusBadge } from "@/components/ui/status-badge";
import { CreateTenantDialog } from "@/components/admin/create-tenant-dialog";
import { InlineOrgSelect } from "@/components/admin/inline-org-select";
import { InlineOrgSlugEdit } from "@/components/admin/inline-org-slug-edit";
import { InlineWalletSelect } from "@/components/admin/inline-wallet-select";
import { InlineActiveToggle } from "@/components/shared/inline-active-toggle";
import { InlineAuthEdit } from "@/components/shared/inline-auth-edit";
import { InlineNameEdit } from "@/components/shared/inline-name-edit";
import { InlineUrlEdit } from "@/components/shared/inline-url-edit";
import { InlineNodeSelect } from "@/components/admin/inline-node-select";
import { InlineTagsEdit } from "@/components/admin/inline-tags-edit";
import { useToast } from "@/components/ui/toast";
import {
  type TenantNode as BaseTenantNode,
  isDeleteDisabled,
  isEditDisabled,
  getEditDisabledReason,
} from "@/lib/tenant-status";
import { getProxyUrl } from "@/lib/format";

const PAGE_SIZE = 10;

interface TenantNode extends BaseTenantNode {
  name: string;
}

interface Tenant {
  id: number;
  name: string;
  backend_url: string;
  is_active: boolean;
  status: string;
  wallet_id: number | null;
  wallet_name: string | null;
  wallet_funding_status: string | null;
  wallet_organization_id: number | null;
  organization_id: number | null;
  organization_name?: string;
  org_slug?: string | null;
  upstream_auth_header: string | null;
  upstream_auth_value: string | null;
  nodes: TenantNode[];
  tags: string[];
  created_at: string;
}

export default function AdminTenantsPage() {
  const {
    data: tenants,
    isLoading,
    mutate,
  } = useSWR("/api/admin/tenants", api.get<Tenant[]>, {
    refreshInterval: 3000,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [tenantToDelete, setTenantToDelete] = useState<Tenant | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const { toast } = useToast();

  const searchLower = search.toLowerCase();
  const filteredTenants =
    tenants?.filter((t) =>
      [t.name, t.organization_name, t.backend_url, ...(t.tags ?? [])].some(
        (value) => value?.toLowerCase().includes(searchLower),
      ),
    ) ?? [];
  const totalCount = filteredTenants.length;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const offset = page * PAGE_SIZE;
  const paginatedTenants = filteredTenants.slice(offset, offset + PAGE_SIZE);
  const hasNextPage = page < totalPages - 1;
  const hasPrevPage = page > 0;

  const handleDeleteClick = (tenant: Tenant) => {
    setTenantToDelete(tenant);
    setDeleteError(null);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!tenantToDelete) return;

    setDeletingId(tenantToDelete.id);
    setDeleteError(null);

    try {
      await api.delete(`/api/admin/tenants/${tenantToDelete.id}`);
      setDeleteDialogOpen(false);
      setTenantToDelete(null);
      void mutate();
      toast({
        title: "Deletion started",
        description: `${tenantToDelete.name} is being deleted`,
        variant: "success",
      });
    } catch (err) {
      if (err instanceof ApiError && err.data) {
        const data = err.data as { error?: string };
        setDeleteError(data.error ?? "Failed to delete tenant");
      } else {
        setDeleteError("Failed to delete tenant");
      }
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-12">Tenants</h1>
          <p className="text-sm text-gray-11">
            Manage all tenants in the system
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-11" />
            <input
              type="text"
              placeholder="Search tenants..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              className="w-64 rounded-md border border-gray-6 bg-gray-3 py-2 pl-9 pr-3 text-sm text-gray-12 placeholder:text-gray-11 focus:border-accent-8 focus:outline-none"
            />
          </div>
          <button
            onClick={() => setDialogOpen(true)}
            className="flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90"
          >
            <PlusIcon className="h-4 w-4" />
            New Tenant
          </button>
        </div>
      </div>

      <CreateTenantDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={() => void mutate()}
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-6 border-t-accent-9" />
        </div>
      ) : tenants?.length ? (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-lg border border-gray-6">
            <table className="w-full min-w-[1200px]">
              <thead className="bg-gray-3">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    ID
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Org Slug
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Tags
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    URL
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Nodes
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Backend URL
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Organization
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Wallet
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Auth
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Active
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Created
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-11">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-6 bg-gray-2">
                {paginatedTenants.map((tenant) => (
                  <tr key={tenant.id} className="hover:bg-gray-3">
                    <td className="px-4 py-3 text-sm text-gray-11">
                      {tenant.id}
                    </td>
                    <td className="px-4 py-3">
                      <InlineNameEdit
                        name={tenant.name}
                        onUpdate={() => void mutate()}
                        apiEndpoint={`/api/admin/tenants/${tenant.id}`}
                        label="Tenant Name"
                        checkAvailabilityEndpoint="/api/admin/tenants/check-name"
                        excludeId={tenant.id}
                        organizationId={tenant.organization_id}
                        disabled={isEditDisabled(tenant)}
                        disabledReason={getEditDisabledReason(tenant)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <InlineOrgSlugEdit
                        tenantId={tenant.id}
                        tenantName={tenant.name}
                        orgSlug={tenant.org_slug}
                        onUpdate={() => void mutate()}
                        disabled={isEditDisabled(tenant)}
                        disabledReason={getEditDisabledReason(tenant)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <InlineTagsEdit
                        apiEndpoint={`/api/admin/tenants/${tenant.id}`}
                        label={tenant.name}
                        tags={tenant.tags ?? []}
                        onUpdate={() => void mutate()}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const url = getProxyUrl({
                              proxyName: tenant.name,
                              orgSlug: tenant.org_slug,
                            });
                            void navigator.clipboard.writeText(url);
                            toast({
                              title: "Proxy URL copied to clipboard",
                              variant: "default",
                            });
                          }}
                          className="p-1.5 rounded border border-gray-6 hover:bg-gray-4 text-gray-11 hover:text-gray-12"
                          title="Copy URL"
                        >
                          <CopyIcon className="h-4 w-4" />
                        </button>
                        <a
                          href={getProxyUrl({
                            proxyName: tenant.name,
                            orgSlug: tenant.org_slug,
                          })}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded border border-gray-6 hover:bg-gray-4 text-gray-11 hover:text-gray-12"
                          title="Open URL"
                        >
                          <ExternalLinkIcon className="h-4 w-4" />
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <InlineNodeSelect
                        tenantId={tenant.id}
                        tenantName={tenant.name}
                        nodes={tenant.nodes}
                        onUpdate={() => void mutate()}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <InlineUrlEdit
                        tenantId={tenant.id}
                        tenantName={tenant.name}
                        backendUrl={tenant.backend_url}
                        onUpdate={() => void mutate()}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <InlineOrgSelect
                        tenantId={tenant.id}
                        tenantName={tenant.name}
                        currentOrgId={tenant.organization_id}
                        currentOrgName={tenant.organization_name ?? null}
                        currentOrgSlug={tenant.org_slug ?? null}
                        currentWalletId={tenant.wallet_id}
                        currentWalletName={tenant.wallet_name}
                        currentWalletOrgId={tenant.wallet_organization_id}
                        onUpdate={() => void mutate()}
                        disabled={isEditDisabled(tenant)}
                        disabledReason={getEditDisabledReason(tenant)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <InlineWalletSelect
                        tenantId={tenant.id}
                        tenantName={tenant.name}
                        tenantOrgId={tenant.organization_id}
                        currentWalletId={tenant.wallet_id}
                        currentWalletName={tenant.wallet_name}
                        onUpdate={() => void mutate()}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <InlineAuthEdit
                        tenantId={tenant.id}
                        tenantName={tenant.name}
                        authHeader={tenant.upstream_auth_header}
                        authValue={tenant.upstream_auth_value}
                        onUpdate={() => void mutate()}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <InlineActiveToggle
                        tenantId={tenant.id}
                        tenantName={tenant.name}
                        isActive={tenant.is_active}
                        onUpdate={() => void mutate()}
                        disabled={tenant.status === "registered"}
                        disabledTooltip="Go live to enable this setting"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge tenant={tenant} />
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-11">
                      {new Date(tenant.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleDeleteClick(tenant)}
                        disabled={isDeleteDisabled(
                          tenant,
                          deletingId === tenant.id,
                        )}
                        className="rounded p-1.5 text-gray-11 hover:bg-red-900/30 hover:text-red-400 disabled:opacity-50"
                        title="Delete tenant"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-11">
                Showing {offset + 1}-{Math.min(offset + PAGE_SIZE, totalCount)}{" "}
                of {totalCount}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => p - 1)}
                  disabled={!hasPrevPage}
                  className="rounded p-1.5 text-gray-11 hover:bg-gray-4 hover:text-gray-12 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeftIcon className="h-4 w-4" />
                </button>
                <span className="text-sm text-gray-11">
                  Page {page + 1} of {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!hasNextPage}
                  className="rounded p-1.5 text-gray-11 hover:bg-gray-4 hover:text-gray-12 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronRightIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-6 bg-gray-2 p-6 text-center">
          <p className="text-sm text-gray-11">No tenants found.</p>
        </div>
      )}

      <Dialog.Root open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-lg">
            <div className="flex items-center justify-between">
              <Dialog.Title className="text-lg font-semibold text-gray-12">
                Delete Tenant
              </Dialog.Title>
              <Dialog.Close className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12">
                <Cross2Icon className="h-4 w-4" />
              </Dialog.Close>
            </div>

            <Dialog.Description asChild>
              <div className="mt-4 space-y-3 text-sm text-gray-11">
                <p>
                  Are you sure you want to delete{" "}
                  <span className="font-medium text-gray-12">
                    {tenantToDelete?.name}
                  </span>
                  ?
                </p>
                <p>
                  This action cannot be undone. All DNS records, TLS
                  certificates, and node configurations will be permanently
                  removed.
                </p>
              </div>
            </Dialog.Description>

            {deleteError && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-800 bg-red-900/20 p-3">
                <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 text-red-400" />
                <p className="text-sm text-red-300">{deleteError}</p>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setDeleteDialogOpen(false)}
                className="rounded-md px-3 py-2 text-sm font-medium text-gray-11 hover:bg-gray-4 hover:text-gray-12"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDeleteConfirm()}
                disabled={deletingId !== null}
                className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deletingId !== null ? "Deleting..." : "Delete"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
