"use client";

import { useState, useCallback, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Cross2Icon, UploadIcon, CheckIcon } from "@radix-ui/react-icons";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";
import { parseOpenApiSpec } from "@/lib/openapi/parser";

interface OpenApiImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: number;
  defaultScheme: string;
  onSuccess: () => void;
}

interface ImportResult {
  success: boolean;
  created: number;
  linked: number;
  paths: {
    created: string[];
    linked: string[];
  };
}

export function OpenApiImportDialog({
  open,
  onOpenChange,
  tenantId,
  defaultScheme,
  onSuccess,
}: OpenApiImportDialogProps) {
  const [mode, setMode] = useState<"upload" | "paste">("upload");
  const [jsonText, setJsonText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [parsedSpec, setParsedSpec] = useState<{
    spec: unknown;
    paths: string[];
    info: { title?: string; version?: string };
  } | null>(null);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const { toast } = useToast();
  const parseIdRef = useRef(0);
  const importingOverFlexPricing =
    defaultScheme === "flex" &&
    parsedSpec !== null &&
    !hasRootPricingExtension(parsedSpec.spec);

  const handleParse = useCallback(async (text: string) => {
    setParseErrors([]);
    setParsedSpec(null);
    setImportResult(null);

    if (!text.trim()) return;

    const currentParseId = ++parseIdRef.current;
    const result = await parseOpenApiSpec(text);

    if (currentParseId !== parseIdRef.current) return;

    if (result.valid && result.spec) {
      setParsedSpec({
        spec: result.spec,
        paths: result.paths,
        info: result.info,
      });
    } else {
      setParseErrors(result.errors);
    }
  }, []);

  const handleFileSelect = useCallback(
    (file: File) => {
      const validTypes = [
        "application/json",
        "application/x-yaml",
        "text/yaml",
      ];
      const validExts = [".json", ".yaml", ".yml"];
      const hasValidType = validTypes.includes(file.type);
      const hasValidExt = validExts.some((ext) => file.name.endsWith(ext));
      if (!hasValidType && !hasValidExt) {
        setParseErrors(["Please select a JSON or YAML file"]);
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        setJsonText(text);
        void handleParse(text);
      };
      reader.readAsText(file);
    },
    [handleParse],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const file = e.dataTransfer.files[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [handleFileSelect],
  );

  const handleImport = async () => {
    if (!parsedSpec || importing) return;

    setImporting(true);
    try {
      const result = await api.post<ImportResult>(
        `/api/tenants/${tenantId}/openapi/import`,
        { spec: parsedSpec.spec },
      );

      setImportResult(result);

      toast({
        title: "OpenAPI spec imported",
        description: `Created ${result.created} endpoints, linked ${result.linked} existing`,
        variant: "success",
      });

      onSuccess();
    } catch {
      toast({
        title: "Failed to import spec",
        variant: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    parseIdRef.current++;
    setJsonText("");
    setParsedSpec(null);
    setParseErrors([]);
    setImportResult(null);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-lg max-h-[85vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-gray-12">
              Import OpenAPI Spec
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12">
              <Cross2Icon className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {importResult ? (
            <div className="mt-4 space-y-4">
              <div className="flex items-center gap-2 text-green-400">
                <CheckIcon className="h-5 w-5" />
                <span className="font-medium">Import Complete</span>
              </div>
              <div className="rounded-md border border-gray-6 bg-gray-3 p-4 text-sm">
                <p className="text-gray-12">
                  Created {importResult.created} endpoint
                  {importResult.created !== 1 ? "s" : ""}
                </p>
                {importResult.linked > 0 && (
                  <p className="text-gray-11">
                    Linked {importResult.linked} existing endpoint
                    {importResult.linked !== 1 ? "s" : ""}
                  </p>
                )}
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleClose}
                  className="rounded-md bg-white px-3 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="flex gap-2">
                <button
                  onClick={() => setMode("upload")}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    mode === "upload"
                      ? "bg-gray-4 text-gray-12"
                      : "text-gray-11 hover:bg-gray-3 hover:text-gray-12"
                  }`}
                >
                  Upload File
                </button>
                <button
                  onClick={() => setMode("paste")}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    mode === "paste"
                      ? "bg-gray-4 text-gray-12"
                      : "text-gray-11 hover:bg-gray-3 hover:text-gray-12"
                  }`}
                >
                  Paste Spec
                </button>
              </div>

              {mode === "upload" ? (
                <div
                  onDrop={handleDrop}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                    isDragging
                      ? "border-accent-9 bg-accent-9/10"
                      : "border-gray-6 hover:border-gray-5"
                  }`}
                >
                  <UploadIcon className="mb-2 h-8 w-8 text-gray-11" />
                  <p className="text-sm text-gray-11">
                    Drag and drop your OpenAPI spec file (JSON or YAML)
                  </p>
                  <p className="mt-1 text-xs text-gray-11">or</p>
                  <label className="mt-2 cursor-pointer rounded-md bg-gray-4 px-3 py-1.5 text-sm font-medium text-gray-12 hover:bg-gray-5">
                    Browse Files
                    <input
                      type="file"
                      accept=".json,.yaml,.yml,application/json,application/x-yaml"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileSelect(file);
                      }}
                      className="hidden"
                    />
                  </label>
                </div>
              ) : (
                <div>
                  <textarea
                    value={jsonText}
                    onChange={(e) => {
                      setJsonText(e.target.value);
                      void handleParse(e.target.value);
                    }}
                    placeholder="Paste OpenAPI spec (JSON or YAML)"
                    className="h-48 w-full rounded-md border border-gray-6 bg-gray-3 px-3 py-2 font-mono text-sm text-gray-12 placeholder-gray-9 focus:border-accent-8 focus:outline-none focus:ring-1 focus:ring-accent-8"
                  />
                </div>
              )}

              {parseErrors.length > 0 && (
                <div className="rounded-md border border-red-800 bg-red-900/20 p-3">
                  <p className="mb-1 text-sm font-medium text-red-400">
                    Validation Errors:
                  </p>
                  <ul className="list-inside list-disc space-y-0.5 text-xs text-red-300">
                    {parseErrors.map((error, i) => (
                      <li key={i}>{error}</li>
                    ))}
                  </ul>
                </div>
              )}

              {parsedSpec && (
                <div className="rounded-md border border-gray-6 bg-gray-3 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-12">
                        {parsedSpec.info.title ?? "Unnamed Spec"}
                      </p>
                      {parsedSpec.info.version && (
                        <p className="text-xs text-gray-11">
                          Version: {parsedSpec.info.version}
                        </p>
                      )}
                    </div>
                    <span className="rounded-full bg-green-900/50 px-2 py-0.5 text-xs text-green-400">
                      Valid
                    </span>
                  </div>
                  <p className="mb-2 text-xs font-medium text-gray-11">
                    {parsedSpec.paths.length} path
                    {parsedSpec.paths.length !== 1 ? "s" : ""} found:
                  </p>
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {parsedSpec.paths.slice(0, 20).map((path) => (
                      <div key={path} className="text-xs">
                        <code className="text-gray-12">{path}</code>
                      </div>
                    ))}
                    {parsedSpec.paths.length > 20 && (
                      <p className="text-xs text-gray-11">
                        ... and {parsedSpec.paths.length - 20} more
                      </p>
                    )}
                  </div>
                </div>
              )}

              {importingOverFlexPricing && (
                <div className="rounded-md border border-yellow-800 bg-yellow-900/20 p-3">
                  <p className="text-sm font-medium text-yellow-400">
                    This proxy uses Flex pricing
                  </p>
                  <p className="mt-1 text-xs text-yellow-200/80">
                    This spec does not include root pricing rules. Review Flex
                    pricing after import.
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-md px-3 py-2 text-sm font-medium text-gray-11 hover:bg-gray-4 hover:text-gray-12"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleImport()}
                  disabled={!parsedSpec || importing}
                  className="rounded-md bg-white px-3 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90 disabled:opacity-50"
                >
                  {importing ? "Importing..." : "Import"}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function hasRootPricingExtension(spec: unknown) {
  return (
    typeof spec === "object" &&
    spec !== null &&
    Object.hasOwn(spec, "x-faremeter-pricing")
  );
}
