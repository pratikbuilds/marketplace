"use client";

import { useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import * as Checkbox from "@radix-ui/react-checkbox";
import {
  Cross2Icon,
  UploadIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/toast";

const ORG_NAME_PATTERN = /^[a-zA-Z0-9 .-]+$/;
const MIN_ORG_NAME_LENGTH = 4;
const MAX_ORG_NAME_LENGTH = 58;

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function validateOrgName(name: string): string | null {
  if (name.length < MIN_ORG_NAME_LENGTH) {
    return `Name must be at least ${MIN_ORG_NAME_LENGTH} characters`;
  }
  if (name.length > MAX_ORG_NAME_LENGTH) {
    return `Name must be at most ${MAX_ORG_NAME_LENGTH} characters`;
  }
  if (!ORG_NAME_PATTERN.test(name)) {
    return "Name can only contain letters, numbers, spaces, hyphens, and periods";
  }
  if (/ {2}/.test(name)) {
    return "Name cannot have consecutive spaces";
  }
  if (/\.{2}/.test(name)) {
    return "Name cannot have consecutive periods";
  }
  if (name.startsWith("-")) {
    return "Name cannot start with a hyphen";
  }
  if (name.endsWith("-")) {
    return "Name cannot end with a hyphen";
  }
  if (name.startsWith(".")) {
    return "Name cannot start with a period";
  }
  if (name.endsWith(".")) {
    return "Name cannot end with a period";
  }
  return null;
}

interface ImportOrgsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

type Step = "upload" | "map" | "preview";

interface ParsedRow {
  name: string;
  slug: string;
  error: string | null;
  existsInDb: boolean;
  previewSuffix: string | null;
}

function generateSlugSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return suffix;
}

interface ImportResult {
  created: { name: string; slug: string }[];
  skipped: { name: string; slug: string }[];
  failed: { name: string; error: string }[];
}

export function ImportOrgsDialog({
  open,
  onOpenChange,
  onSuccess,
}: ImportOrgsDialogProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("upload");
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvData, setCsvData] = useState<string[][]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [nameColumn, setNameColumn] = useState<string>("");
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [showOnlyInvalid, setShowOnlyInvalid] = useState(false);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);

  const resetState = () => {
    setStep("upload");
    setIsDragging(false);
    setFileName(null);
    setCsvData([]);
    setHeaders([]);
    setNameColumn("");
    setParsedRows([]);
    setImporting(false);
    setImportResult(null);
    setParseError(null);
    setShowOnlyInvalid(false);
    setSkipDuplicates(true);
  };

  const handleClose = () => {
    resetState();
    onOpenChange(false);
  };

  const processFileData = useCallback((data: string[][], fileType: string) => {
    let rowStart = 0;
    while (
      rowStart < data.length &&
      data[rowStart].every((cell) => (cell ?? "").trim() === "")
    ) {
      rowStart++;
    }

    const rowsWithData = data.slice(rowStart);
    if (rowsWithData.length < 1) {
      setParseError(`${fileType} must have at least one data row`);
      return;
    }

    let colStart = 0;
    const maxCols = Math.max(...rowsWithData.map((r) => r.length));
    while (colStart < maxCols) {
      const colHasData = rowsWithData.some((row) =>
        (row[colStart] ?? "").trim(),
      );
      if (colHasData) break;
      colStart++;
    }

    const filtered = rowsWithData
      .filter((row) => row.some((cell) => (cell ?? "").trim() !== ""))
      .map((row) => row.slice(colStart).map((c) => c ?? ""));

    if (filtered.length < 1) {
      setParseError(`${fileType} must have at least one data row`);
      return;
    }

    const headerRow = filtered[0];
    setHeaders(headerRow);
    setCsvData(filtered.slice(1));

    const nameIdx = headerRow.findIndex(
      (h) =>
        h.toLowerCase() === "name" ||
        h.toLowerCase() === "org_name" ||
        h.toLowerCase() === "organization" ||
        h.toLowerCase() === "organization_name",
    );
    if (nameIdx !== -1) {
      setNameColumn(headerRow[nameIdx]);
    }
  }, []);

  const handleFileSelect = useCallback(
    (file: File) => {
      const isCSV = file.name.endsWith(".csv") || file.type === "text/csv";
      const isXLSX =
        file.name.endsWith(".xlsx") ||
        file.name.endsWith(".xls") ||
        file.type ===
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        file.type === "application/vnd.ms-excel";

      if (!isCSV && !isXLSX) {
        setParseError("Please select a CSV or Excel file");
        return;
      }

      setFileName(file.name);
      setParseError(null);

      if (isXLSX) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = e.target?.result;
            const workbook = XLSX.read(data, { type: "array" });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json<string[]>(firstSheet, {
              header: 1,
            });
            processFileData(jsonData, "Excel file");
          } catch (err) {
            setParseError(
              `Failed to parse Excel file: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
          }
        };
        reader.readAsArrayBuffer(file);
      } else {
        Papa.parse<string[]>(file, {
          complete: (results) => {
            if (results.errors.length > 0) {
              setParseError(`CSV parse error: ${results.errors[0].message}`);
              return;
            }
            processFileData(results.data, "CSV");
          },
          error: (error) => {
            setParseError(`Failed to parse CSV: ${error.message}`);
          },
        });
      }
    },
    [processFileData],
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

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const processRows = useCallback(() => {
    if (!nameColumn || csvData.length === 0) return;

    const nameIdx = headers.indexOf(nameColumn);
    if (nameIdx === -1) return;

    const seenNames = new Set<string>();
    const seenSlugs = new Set<string>();

    const rows: ParsedRow[] = csvData
      .map((row) => {
        const name = row[nameIdx]?.trim() || "";
        return { name, slug: slugify(name) };
      })
      .filter(({ name }) => name.length > 0)
      .map(({ name, slug }) => {
        const validationError = validateOrgName(name);
        if (validationError) {
          return {
            name,
            slug,
            error: validationError,
            existsInDb: false,
            previewSuffix: null,
          };
        }

        if (seenNames.has(name.toLowerCase())) {
          return {
            name,
            slug,
            error: "Duplicate name in import",
            existsInDb: false,
            previewSuffix: null,
          };
        }

        if (seenSlugs.has(slug)) {
          return {
            name,
            slug,
            error: "Duplicate slug in import",
            existsInDb: false,
            previewSuffix: null,
          };
        }

        seenNames.add(name.toLowerCase());
        seenSlugs.add(slug);

        return {
          name,
          slug,
          error: null,
          existsInDb: false,
          previewSuffix: null,
        };
      });

    return rows;
  }, [nameColumn, csvData, headers]);

  const goToMapStep = () => {
    if (csvData.length > 0) {
      setStep("map");
    }
  };

  const goToPreviewStep = async () => {
    if (!nameColumn) return;

    const rows = processRows();
    if (!rows || rows.length === 0) return;

    setCheckingDuplicates(true);
    setStep("preview");

    try {
      const validSlugs = rows.filter((r) => !r.error).map((r) => r.slug);
      if (validSlugs.length > 0) {
        const { existing } = await api.post<{ existing: string[] }>(
          "/api/admin/organizations/check-slugs",
          { slugs: validSlugs },
        );
        const existingSet = new Set(existing);
        const updatedRows = rows.map((row) => {
          const exists = !row.error && existingSet.has(row.slug);
          return {
            ...row,
            existsInDb: exists,
            previewSuffix: exists ? generateSlugSuffix() : null,
          };
        });
        setParsedRows(updatedRows);
      } else {
        setParsedRows(rows);
      }
    } catch {
      setParsedRows(rows);
    } finally {
      setCheckingDuplicates(false);
    }
  };

  const handleImport = async () => {
    const validRows = parsedRows.filter((r) => !r.error);
    if (validRows.length === 0) return;

    setImporting(true);
    try {
      const result = await api.post<ImportResult>(
        "/api/admin/organizations/import",
        {
          names: validRows.map((r) => r.name),
          skip_duplicates: skipDuplicates,
        },
      );

      setImportResult(result);

      if (result.created.length > 0) {
        toast({
          title: "Organizations imported",
          description: `Created ${result.created.length} organization${result.created.length !== 1 ? "s" : ""}`,
          variant: "success",
        });
        onSuccess();
      }
    } catch {
      toast({
        title: "Import failed",
        description: "Failed to import organizations",
        variant: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  const invalidCount = parsedRows.filter((r) => r.error).length;
  const existingCount = parsedRows.filter(
    (r) => !r.error && r.existsInDb,
  ).length;
  const newCount = parsedRows.filter((r) => !r.error && !r.existsInDb).length;
  const importCount = skipDuplicates ? newCount : newCount + existingCount;

  return (
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-4xl -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-6 bg-gray-2 p-6 shadow-lg max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-gray-12">
              Import Organizations
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12">
              <Cross2Icon className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* Step indicators */}
          {!importResult && (
            <div className="mt-4 flex items-center gap-2 text-sm">
              <span
                className={
                  step === "upload"
                    ? "text-gray-12 font-medium"
                    : "text-gray-11"
                }
              >
                1. Upload
              </span>
              <span className="text-gray-8">/</span>
              <span
                className={
                  step === "map" ? "text-gray-12 font-medium" : "text-gray-11"
                }
              >
                2. Select Column
              </span>
              <span className="text-gray-8">/</span>
              <span
                className={
                  step === "preview"
                    ? "text-gray-12 font-medium"
                    : "text-gray-11"
                }
              >
                3. Preview
              </span>
            </div>
          )}

          {importResult ? (
            <div className="mt-4 space-y-4">
              <div className="flex items-center gap-2 text-green-400">
                <CheckIcon className="h-5 w-5" />
                <span className="font-medium">Import Complete</span>
              </div>
              <div className="rounded-md border border-gray-6 bg-gray-3 p-4 text-sm space-y-1">
                <p className="text-gray-12">
                  Created {importResult.created.length} organization
                  {importResult.created.length !== 1 ? "s" : ""}
                </p>
                {importResult.skipped.length > 0 && (
                  <p className="text-gray-11">
                    Skipped: {importResult.skipped.length} (already exist)
                  </p>
                )}
                {importResult.failed.length > 0 && (
                  <p className="text-red-400">
                    Failed: {importResult.failed.length}
                  </p>
                )}
              </div>
              {importResult.failed.length > 0 && (
                <div className="rounded-md border border-red-900 bg-red-950/50 p-3 text-sm">
                  <p className="text-red-400 font-medium mb-2">
                    Failed imports:
                  </p>
                  <ul className="space-y-1 text-gray-11">
                    {importResult.failed.map((f, i) => (
                      <li key={i}>
                        {f.name}: {f.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex justify-end">
                <button
                  onClick={handleClose}
                  className="rounded-md bg-white px-3 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90"
                >
                  Done
                </button>
              </div>
            </div>
          ) : step === "upload" ? (
            <div className="mt-4 space-y-4">
              <div
                onDrop={handleDrop}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                  isDragging
                    ? "border-accent-9 bg-accent-3"
                    : "border-gray-6 hover:border-gray-8"
                }`}
              >
                <UploadIcon className="h-8 w-8 text-gray-11 mb-3" />
                <p className="text-gray-12 text-sm mb-1">
                  {fileName ?? "Drop your CSV or Excel file here"}
                </p>
                <p className="text-gray-11 text-xs mb-3">or</p>
                <label className="cursor-pointer rounded-md bg-gray-4 px-3 py-1.5 text-sm font-medium text-gray-12 hover:bg-gray-5 transition-colors">
                  Browse files
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                    onChange={handleFileInput}
                    className="hidden"
                  />
                </label>
              </div>

              {parseError && (
                <div className="rounded-md border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">
                  {parseError}
                </div>
              )}

              {fileName && !parseError && csvData.length > 0 && (
                <p className="text-sm text-gray-11">
                  Found {csvData.length} row{csvData.length !== 1 ? "s" : ""} in{" "}
                  {fileName}
                </p>
              )}

              <div className="flex justify-end">
                <button
                  onClick={goToMapStep}
                  disabled={
                    !fileName || parseError !== null || csvData.length === 0
                  }
                  className="rounded-md bg-white px-3 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          ) : step === "map" ? (
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-12 mb-2">
                  Select the column containing organization names
                </label>
                <Select.Root value={nameColumn} onValueChange={setNameColumn}>
                  <Select.Trigger className="inline-flex w-full items-center justify-between rounded-md border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 hover:bg-gray-4 focus:outline-none focus:ring-2 focus:ring-accent-8">
                    <Select.Value placeholder="Select column..." />
                    <Select.Icon>
                      <ChevronDownIcon className="h-4 w-4 text-gray-11" />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content className="overflow-hidden rounded-md border border-gray-6 bg-gray-3 shadow-lg">
                      <Select.ScrollUpButton className="flex h-6 items-center justify-center bg-gray-3 text-gray-11">
                        <ChevronUpIcon />
                      </Select.ScrollUpButton>
                      <Select.Viewport className="p-1">
                        {headers.map((header) => (
                          <Select.Item
                            key={header}
                            value={header}
                            className="relative flex cursor-pointer select-none items-center rounded px-8 py-2 text-sm text-gray-12 hover:bg-gray-5 focus:bg-gray-5 focus:outline-none"
                          >
                            <Select.ItemText>{header}</Select.ItemText>
                            <Select.ItemIndicator className="absolute left-2">
                              <CheckIcon className="h-4 w-4" />
                            </Select.ItemIndicator>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                      <Select.ScrollDownButton className="flex h-6 items-center justify-center bg-gray-3 text-gray-11">
                        <ChevronDownIcon />
                      </Select.ScrollDownButton>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>

              {nameColumn && csvData.length > 0 && (
                <div className="rounded-md border border-gray-6 bg-gray-3 p-3 text-sm">
                  <p className="text-gray-11 mb-1">Sample value:</p>
                  <p className="text-gray-12">
                    {csvData[0][headers.indexOf(nameColumn)] || "(empty)"}
                  </p>
                </div>
              )}

              <div className="flex justify-between">
                <button
                  onClick={() => setStep("upload")}
                  className="rounded-md bg-gray-4 px-3 py-2 text-sm font-medium text-gray-12 hover:bg-gray-5 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => void goToPreviewStep()}
                  disabled={!nameColumn || checkingDuplicates}
                  className="rounded-md bg-white px-3 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {checkingDuplicates ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black" />
                      Checking...
                    </span>
                  ) : (
                    "Next"
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-4">
                  {checkingDuplicates ? (
                    <span className="text-gray-11">
                      Checking for duplicates...
                    </span>
                  ) : (
                    <>
                      <span className="text-green-400">
                        <CheckIcon className="inline h-4 w-4 mr-1" />
                        New: {newCount}
                      </span>
                      {existingCount > 0 && (
                        <span className="text-yellow-400">
                          <ExclamationTriangleIcon className="inline h-4 w-4 mr-1" />
                          Existing: {existingCount}
                        </span>
                      )}
                      {invalidCount > 0 && (
                        <span className="text-red-400">
                          <CrossCircledIcon className="inline h-4 w-4 mr-1" />
                          Invalid: {invalidCount}
                        </span>
                      )}
                    </>
                  )}
                </div>
                {invalidCount > 0 && (
                  <label
                    className="flex items-center gap-2 cursor-pointer"
                    title="Filter the table to show only rows with validation errors"
                  >
                    <Checkbox.Root
                      checked={showOnlyInvalid}
                      onCheckedChange={(checked) =>
                        setShowOnlyInvalid(checked === true)
                      }
                      className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                        showOnlyInvalid
                          ? "border-gray-12 bg-gray-12"
                          : "border-gray-6 bg-gray-3 hover:border-gray-8"
                      }`}
                    >
                      <Checkbox.Indicator>
                        <CheckIcon className="h-3.5 w-3.5 text-gray-1" />
                      </Checkbox.Indicator>
                    </Checkbox.Root>
                    <span className="text-gray-12">Show only invalid</span>
                  </label>
                )}
              </div>

              <div className="overflow-x-auto rounded-lg border border-gray-6 max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-3 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-gray-11 font-medium">
                        #
                      </th>
                      <th className="px-3 py-2 text-left text-gray-11 font-medium">
                        Name
                      </th>
                      <th className="px-3 py-2 text-left text-gray-11 font-medium">
                        Slug
                      </th>
                      <th className="px-3 py-2 text-left text-gray-11 font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-6">
                    {parsedRows
                      .filter((row) => !showOnlyInvalid || row.error)
                      .map((row, idx) => (
                        <tr
                          key={idx}
                          className={row.error ? "bg-red-950/20" : ""}
                        >
                          <td className="px-3 py-2 text-gray-11">{idx + 1}</td>
                          <td className="px-3 py-2 text-gray-12">
                            {row.name || "(empty)"}
                          </td>
                          <td className="px-3 py-2 text-gray-11 font-mono text-xs">
                            {row.existsInDb &&
                            !skipDuplicates &&
                            row.previewSuffix
                              ? `${row.slug}-${row.previewSuffix}`
                              : row.slug || "-"}
                          </td>
                          <td className="px-3 py-2">
                            {row.error ? (
                              <span className="text-red-400 text-xs">
                                {row.error}
                              </span>
                            ) : row.existsInDb ? (
                              <span className="text-yellow-400 text-xs flex items-center gap-1">
                                <ExclamationTriangleIcon className="h-3 w-3" />
                                {skipDuplicates ? "Will skip" : "Exists"}
                              </span>
                            ) : (
                              <span className="text-green-400 text-xs flex items-center gap-1">
                                <CheckIcon className="h-3 w-3" />
                                New
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <Checkbox.Root
                    checked={skipDuplicates}
                    onCheckedChange={(checked) =>
                      setSkipDuplicates(checked === true)
                    }
                    className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                      skipDuplicates
                        ? "border-gray-12 bg-gray-12"
                        : "border-gray-6 bg-gray-3 hover:border-gray-8"
                    }`}
                  >
                    <Checkbox.Indicator>
                      <CheckIcon className="h-3.5 w-3.5 text-gray-1" />
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                  <span className="text-gray-12">
                    Skip existing organizations
                  </span>
                </label>
                <p className="text-xs text-gray-11 mt-1 ml-7">
                  When disabled, a suffix will be added to create a unique slug
                </p>
              </div>

              <div className="flex justify-between">
                <button
                  onClick={() => setStep("map")}
                  className="rounded-md bg-gray-4 px-3 py-2 text-sm font-medium text-gray-12 hover:bg-gray-5 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => void handleImport()}
                  disabled={
                    importCount === 0 || importing || checkingDuplicates
                  }
                  className="rounded-md bg-white px-3 py-2 text-sm font-medium text-black shadow-button transition-colors hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {importing ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black" />
                      Importing...
                    </span>
                  ) : (
                    `Import ${importCount} Organization${importCount !== 1 ? "s" : ""}`
                  )}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
