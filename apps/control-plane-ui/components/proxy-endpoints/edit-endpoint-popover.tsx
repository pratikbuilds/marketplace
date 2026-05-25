import { EndpointEditDialog } from "./endpoint-edit-dialog";

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

type EditEndpointPopoverProps = {
  endpoint: Endpoint;
  tenantId: number;
  defaultScheme: string;
  initialScheme?: string;
  onClose: () => void;
  onSuccess: () => void;
};

export function EditEndpointPopover({
  endpoint,
  tenantId,
  defaultScheme,
  initialScheme,
  onClose,
  onSuccess,
}: EditEndpointPopoverProps) {
  return (
    <EndpointEditDialog
      endpoint={endpoint}
      tenantId={tenantId}
      defaultScheme={defaultScheme}
      initialScheme={initialScheme}
      updateEndpointApiPath={`/api/tenants/${tenantId}/endpoints/${endpoint.id}`}
      showTokenPrices
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}
