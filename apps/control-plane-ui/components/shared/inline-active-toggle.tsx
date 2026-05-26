"use client";

import { useState } from "react";
import * as Switch from "@radix-ui/react-switch";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";

interface InlineActiveToggleProps {
  tenantId: number;
  tenantName: string;
  isActive: boolean;
  onUpdate: () => void;
  apiEndpoint?: string;
  disabled?: boolean;
  disabledTooltip?: string;
}

export function InlineActiveToggle({
  tenantId,
  tenantName,
  isActive,
  onUpdate,
  apiEndpoint,
  disabled,
  disabledTooltip,
}: InlineActiveToggleProps) {
  const endpoint = apiEndpoint ?? `/api/admin/tenants/${tenantId}`;
  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);

  const isDisabled = disabled === true || isSaving;

  const handleToggle = async () => {
    setIsSaving(true);
    try {
      await api.put(endpoint, {
        is_active: !isActive,
      });
      toast({
        title: isActive ? "Tenant deactivated" : "Tenant activated",
        description: `${tenantName} is now ${isActive ? "inactive" : "active"}.`,
        variant: "success",
      });
      onUpdate();
    } catch (err) {
      toast({
        title: "Failed to update",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const toggle = (
    <Switch.Root
      checked={isActive}
      onCheckedChange={() => void handleToggle()}
      disabled={isDisabled}
      className={`relative h-5 w-9 rounded-full transition-colors ${
        isDisabled
          ? "opacity-50 cursor-not-allowed bg-gray-6"
          : isActive
            ? "bg-green-600"
            : "bg-gray-6"
      }`}
    >
      <Switch.Thumb
        className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
          isActive ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </Switch.Root>
  );

  if (disabled && disabledTooltip) {
    return (
      <span title={disabledTooltip} className="inline-block">
        {toggle}
      </span>
    );
  }

  return toggle;
}
