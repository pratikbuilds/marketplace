"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import * as Toast from "@radix-ui/react-toast";
import { Cross2Icon, CheckCircledIcon } from "@radix-ui/react-icons";

interface ToastData {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "success" | "error";
  createdAt: number;
}

interface ToastContextValue {
  toast: (data: Omit<ToastData, "id" | "createdAt">) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION = 5000;

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const toast = useCallback((data: Omit<ToastData, "id" | "createdAt">) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...data, id, createdAt: Date.now() }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Auto-remove toasts after duration
  useEffect(() => {
    if (toasts.length === 0) return;

    const timer = setInterval(() => {
      const now = Date.now();
      setToasts((prev) =>
        prev.filter((t) => now - t.createdAt < TOAST_DURATION),
      );
    }, 100);

    return () => clearInterval(timer);
  }, [toasts.length]);

  return (
    <ToastContext.Provider value={{ toast }}>
      <Toast.Provider swipeDirection="right">
        {children}
        {toasts.map((t) => (
          <Toast.Root
            key={t.id}
            open={true}
            onOpenChange={(open) => !open && removeToast(t.id)}
            className={`rounded-lg border p-4 shadow-lg ${
              t.variant === "success"
                ? "border-green-800 bg-green-900/80"
                : t.variant === "error"
                  ? "border-red-800 bg-red-900/80"
                  : "border-gray-6 bg-gray-2"
            }`}
          >
            <div className="flex items-start gap-3">
              {t.variant === "success" && (
                <CheckCircledIcon className="h-5 w-5 text-green-400 shrink-0 mt-0.5" />
              )}
              <div className="flex-1">
                <Toast.Title className="text-sm font-medium text-gray-12">
                  {t.title}
                </Toast.Title>
                {t.description && (
                  <Toast.Description className="mt-1 text-sm text-gray-11">
                    {t.description}
                  </Toast.Description>
                )}
              </div>
              <Toast.Close className="rounded p-1 text-gray-11 hover:bg-gray-4 hover:text-gray-12">
                <Cross2Icon className="h-4 w-4" />
              </Toast.Close>
            </div>
          </Toast.Root>
        ))}
        <Toast.Viewport className="fixed top-4 right-4 z-[80] flex flex-col gap-2 w-[480px] max-w-[calc(100vw-2rem)]" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}
