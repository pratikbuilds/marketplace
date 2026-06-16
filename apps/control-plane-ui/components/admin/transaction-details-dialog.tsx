"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Cross2Icon, ExternalLinkIcon } from "@radix-ui/react-icons";
import { formatUSDC } from "@/lib/analytics";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";

interface Transaction {
  id: number;
  endpoint_id: number | null;
  tenant_id: number;
  organization_id: number | null;
  amount: number;
  tx_hash: string | null;
  network: string | null;
  token_symbol: string | null;
  mint_address: string | null;
  request_path: string;
  client_ip: string | null;
  request_method: string | null;
  metadata: unknown;
  ngx_request_id: string;
  created_at: string;
}

interface TransactionDetailsDialogProps {
  transaction: Transaction;
  onClose: () => void;
}

function getExplorerUrl(network: string | null, txHash: string): string {
  switch (network) {
    case "solana":
    case "solana-mainnet-beta":
      return `https://solscan.io/tx/${txHash}`;
    case "solana-devnet":
      return `https://solscan.io/tx/${txHash}?cluster=devnet`;
    case "base":
      return `https://basescan.org/tx/${txHash}`;
    case "polygon":
      return `https://polygonscan.com/tx/${txHash}`;
    case "monad":
      return `https://explorer.monad.xyz/tx/${txHash}`;
    default:
      return `https://solscan.io/tx/${txHash}`;
  }
}

function getMethodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "bg-blue-900/50 text-blue-400 border border-blue-800";
    case "POST":
      return "bg-green-900/50 text-green-400 border border-green-800";
    case "PUT":
      return "bg-amber-900/50 text-amber-400 border border-amber-800";
    case "PATCH":
      return "bg-orange-900/50 text-orange-400 border border-orange-800";
    case "DELETE":
      return "bg-red-900/50 text-red-400 border border-red-800";
    default:
      return "bg-gray-4 text-gray-11 border border-gray-6";
  }
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-gray-11">{label}</span>
      <div className="text-right">{children}</div>
    </div>
  );
}

const jsonTheme = {
  ...darkTheme,
  "--w-rjv-background-color": "transparent",
  "--w-rjv-font-family": "ui-monospace, monospace",
  "--w-rjv-color": "#e5e5e5",
  "--w-rjv-key-string": "#7dd3fc",
  "--w-rjv-type-string-color": "#fcd34d",
  "--w-rjv-type-int-color": "#93c5fd",
  "--w-rjv-type-boolean-color": "#c4b5fd",
  "--w-rjv-type-null-color": "#a3a3a3",
  "--w-rjv-curlybraces-color": "#a3a3a3",
  "--w-rjv-brackets-color": "#a3a3a3",
  "--w-rjv-colon-color": "#a3a3a3",
  "--w-rjv-arrow-color": "#a3a3a3",
};

export function TransactionDetailsDialog({
  transaction,
  onClose,
}: TransactionDetailsDialogProps) {
  const metadata = transaction.metadata as Record<string, unknown> | null;
  const [jsonCollapsed, setJsonCollapsed] = useState<boolean | number>(1);

  return (
    <Dialog.Root open onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[85vh] w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-gray-6 bg-gray-1 shadow-2xl">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-6 bg-gray-1 px-6 py-4">
            <div>
              <Dialog.Title className="text-lg font-semibold text-gray-12">
                Transaction #{transaction.id}
              </Dialog.Title>
              <p className="mt-0.5 text-xs text-gray-11">
                {new Date(transaction.created_at).toLocaleString()}
              </p>
            </div>
            <Dialog.Close className="rounded-lg p-2 text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12">
              <Cross2Icon className="h-5 w-5" />
            </Dialog.Close>
          </div>

          <div className="space-y-6 p-6">
            {/* Request Section */}
            <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-11">
                Request
              </h3>
              <div className="flex items-center gap-3">
                {transaction.request_method && (
                  <span
                    className={`inline-flex rounded px-2 py-1 text-xs font-bold ${getMethodColor(transaction.request_method)}`}
                  >
                    {transaction.request_method}
                  </span>
                )}
                <code className="flex-1 rounded-md bg-gray-3 px-3 py-2 font-mono text-sm text-gray-12">
                  {transaction.request_path}
                </code>
              </div>
              {transaction.client_ip && (
                <div className="mt-3 flex items-center gap-2 text-sm">
                  <span className="text-gray-11">from</span>
                  <code className="rounded bg-gray-3 px-2 py-0.5 font-mono text-xs text-gray-12">
                    {transaction.client_ip}
                  </code>
                </div>
              )}
            </div>

            {/* Payment Section */}
            <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-11">
                Payment
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-gray-11">Amount</p>
                  <p className="mt-1 text-2xl font-semibold text-green-400">
                    {formatUSDC(transaction.amount)}
                  </p>
                  {transaction.token_symbol &&
                    transaction.token_symbol !== "USDC" && (
                      <p className="mt-1 text-xs text-amber-400">
                        Paid with {transaction.token_symbol}
                      </p>
                    )}
                </div>
                <div>
                  <p className="text-xs text-gray-11">Network</p>
                  <p className="mt-1">
                    {transaction.network ? (
                      <span className="inline-flex rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-sm font-medium text-gray-12">
                        {transaction.network}
                      </span>
                    ) : (
                      <span className="text-sm text-gray-11">-</span>
                    )}
                  </p>
                </div>
              </div>
              {transaction.tx_hash && (
                <div className="mt-4 border-t border-gray-6 pt-4">
                  <p className="text-xs text-gray-11">Transaction Hash</p>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 break-all rounded-md bg-gray-3 px-3 py-2 font-mono text-xs text-gray-12">
                      {transaction.tx_hash}
                    </code>
                    <a
                      href={getExplorerUrl(
                        transaction.network,
                        transaction.tx_hash,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-shrink-0 rounded-lg p-2 text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12"
                    >
                      <ExternalLinkIcon className="h-4 w-4" />
                    </a>
                  </div>
                </div>
              )}
            </div>

            {/* IDs Section */}
            <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-11">
                References
              </h3>
              <div className="divide-y divide-gray-6">
                <InfoRow label="Request ID">
                  <code className="rounded bg-gray-3 px-2 py-0.5 font-mono text-xs text-gray-12">
                    {transaction.ngx_request_id}
                  </code>
                </InfoRow>
                <InfoRow label="Tenant ID">
                  <span className="text-sm text-gray-12">
                    {transaction.tenant_id}
                  </span>
                </InfoRow>
                <InfoRow label="Endpoint ID">
                  <span className="text-sm text-gray-12">
                    {transaction.endpoint_id ?? "-"}
                  </span>
                </InfoRow>
                <InfoRow label="Organization ID">
                  <span className="text-sm text-gray-12">
                    {transaction.organization_id ?? "-"}
                  </span>
                </InfoRow>
              </div>
            </div>

            {/* Metadata Section */}
            {metadata && Object.keys(metadata).length > 0 && (
              <div className="rounded-lg border border-gray-6 bg-gray-2 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-11">
                    Metadata
                  </h3>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setJsonCollapsed(false)}
                      className="rounded px-2 py-1 text-xs text-gray-11 hover:bg-gray-4 hover:text-gray-12"
                    >
                      Expand
                    </button>
                    <button
                      onClick={() => setJsonCollapsed(true)}
                      className="rounded px-2 py-1 text-xs text-gray-11 hover:bg-gray-4 hover:text-gray-12"
                    >
                      Collapse
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto rounded-md border border-gray-6 bg-gray-3 p-3 text-xs">
                  <JsonView
                    key={String(jsonCollapsed)}
                    value={metadata}
                    style={jsonTheme}
                    collapsed={jsonCollapsed}
                    displayDataTypes={false}
                    displayObjectSize={false}
                    enableClipboard={false}
                    shortenTextAfterLength={60}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="sticky bottom-0 border-t border-gray-6 bg-gray-1 px-6 py-4">
            <button
              onClick={onClose}
              className="w-full rounded-lg bg-gray-12 px-4 py-2.5 text-sm font-medium text-gray-1 transition-colors hover:bg-gray-11"
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
