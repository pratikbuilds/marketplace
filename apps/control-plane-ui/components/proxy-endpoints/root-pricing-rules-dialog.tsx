"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Cross2Icon } from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import { PricingRulesForm } from "./pricing-rules-form";

interface RootPricingRulesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: number;
  defaultSchemeApiEndpoint: string;
  onSaved: () => void;
}

export function RootPricingRulesDialog({
  open,
  onOpenChange,
  tenantId,
  defaultSchemeApiEndpoint,
  onSaved,
}: RootPricingRulesDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="scrollbar-none fixed left-1/2 top-1/2 max-h-[90vh] w-[min(920px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-lg">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-gray-12">
              Edit Default Flex Pricing
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12">
              <Cross2Icon className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="mt-4">
            <PricingRulesForm
              tenantId={tenantId}
              mode="tenant"
              scheme="flex"
              hasOpenApiLineage
              onSaved={async () => {
                await api.put(defaultSchemeApiEndpoint, {
                  default_scheme: "flex",
                });
                onSaved();
                onOpenChange(false);
              }}
              showSaveButton
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
