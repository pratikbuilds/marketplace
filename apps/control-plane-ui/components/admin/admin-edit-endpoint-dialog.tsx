import { EndpointEditDialog } from "@/components/proxy-endpoints/endpoint-edit-dialog";

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

type AdminEditEndpointDialogProps = {
  endpoint: Endpoint;
  tenantId: number;
  defaultPrice: number;
  defaultScheme: string;
  initialScheme?: string;
  onClose: () => void;
  onSuccess: () => void;
};

export function AdminEditEndpointDialog({
  endpoint,
  tenantId,
  defaultPrice,
  defaultScheme,
  initialScheme,
  onClose,
  onSuccess,
}: AdminEditEndpointDialogProps) {
  return (
    <EndpointEditDialog
      endpoint={endpoint}
      tenantId={tenantId}
      defaultScheme={defaultScheme}
      initialScheme={initialScheme}
      defaultPrice={defaultPrice}
      inheritDefaultScheme={false}
      priceStep={0.001}
      pricePlaceholder="0.001"
      priceUnit="USDC"
      updateEndpointApiPath={`/api/admin/tenants/${tenantId}/endpoints/${endpoint.id}`}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}
