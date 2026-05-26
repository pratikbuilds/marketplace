"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Pencil1Icon, CheckIcon, Cross2Icon } from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";
import { SCHEME_OPTIONS } from "@/lib/types/api";

interface InlineSchemeEditProps {
  scheme: string;
  defaultScheme?: string;
  onUpdate: () => void;
  apiEndpoint: string;
  fieldName?: string;
  label?: string;
  onFullEditRequired?: (scheme: string) => void;
}

export function InlineSchemeEdit({
  scheme,
  defaultScheme,
  onUpdate,
  apiEndpoint,
  fieldName = "default_scheme",
  label = "Default Scheme",
  onFullEditRequired,
}: InlineSchemeEditProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedScheme, setSelectedScheme] = useState(scheme);

  const handleSave = async () => {
    if (selectedScheme === "flex" && onFullEditRequired) {
      onFullEditRequired(selectedScheme);
      setIsOpen(false);
      return;
    }

    setIsSaving(true);
    try {
      // If defaultScheme is provided and value matches, send null to use default
      const valueToSend =
        defaultScheme !== undefined && selectedScheme === defaultScheme
          ? null
          : selectedScheme;
      await api.put(apiEndpoint, {
        [fieldName]: valueToSend,
      });
      toast({
        title: "Scheme updated",
        variant: "default",
      });
      onUpdate();
      setIsOpen(false);
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

  const handleOpen = (open: boolean) => {
    if (open) {
      setSelectedScheme(scheme);
    }
    setIsOpen(open);
  };

  return (
    <Popover.Root open={isOpen} onOpenChange={handleOpen}>
      <Popover.Trigger asChild>
        <button className="group flex items-center gap-1 rounded bg-gray-4 px-2 py-1 text-xs text-gray-11 hover:bg-gray-5 cursor-pointer text-left">
          <span>{scheme}</span>
          <Pencil1Icon className="h-3 w-3 opacity-50 group-hover:opacity-100" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="w-48 rounded-lg border border-gray-6 bg-gray-2 p-3 shadow-lg"
          sideOffset={5}
          align="start"
        >
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-11 mb-1">
                {label}
              </label>
              <div className="space-y-1">
                {SCHEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={option.disabled}
                    onClick={() => setSelectedScheme(option.value)}
                    className={`w-full rounded px-3 py-1.5 text-left text-sm transition-colors ${
                      option.disabled && selectedScheme === option.value
                        ? "bg-gray-6 text-gray-11 cursor-not-allowed"
                        : option.disabled
                          ? "text-gray-8 cursor-not-allowed"
                          : selectedScheme === option.value
                            ? "bg-accent-9 text-white"
                            : "text-gray-12 hover:bg-gray-4"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setIsOpen(false)}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-11 hover:bg-gray-4"
              >
                <Cross2Icon className="h-3 w-3" />
                Cancel
              </button>
              <button
                onClick={() => void handleSave()}
                disabled={isSaving}
                className="inline-flex items-center gap-1 rounded bg-accent-9 px-2 py-1 text-xs text-white hover:bg-accent-10 disabled:opacity-50"
              >
                <CheckIcon className="h-3 w-3" />
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
          <Popover.Arrow className="fill-gray-6" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
