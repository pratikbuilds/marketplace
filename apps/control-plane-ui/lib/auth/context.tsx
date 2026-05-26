"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import useSWR from "swr";
import { api, ApiError } from "@/lib/api/client";

export interface Organization {
  id: number;
  name: string;
  slug: string;
  role: string;
}

export interface User {
  id: number;
  email: string;
  is_admin: boolean;
  email_verified?: boolean;
  organizations: Organization[];
  impersonating?: boolean;
  impersonated_by?: { id: number; email: string };
}

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  error: Error | null;
  currentOrg: Organization | null;
  setCurrentOrg: (org: Organization | null) => void;
  login: (email: string, password: string) => Promise<User>;
  signup: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  stopImpersonation: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentOrg, setCurrentOrgState] = useState<Organization | null>(null);

  const auth = useSWR<User, Error>(
    "/api/auth/me",
    (url: string) => api.get<User>(url),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      onSuccess: (data) => {
        if (data?.organizations?.length && !currentOrg) {
          const savedOrgId = localStorage.getItem("currentOrgId");
          const savedOrg = savedOrgId
            ? data.organizations.find((o) => o.id === parseInt(savedOrgId))
            : null;
          setCurrentOrgState(savedOrg ?? data.organizations[0]);
        }
      },
      onError: () => {
        setCurrentOrgState(null);
      },
    },
  );
  const user = auth.data;
  const error = auth.error;
  const isLoading = auth.isLoading;
  const mutate = auth.mutate;

  const setCurrentOrg = useCallback((org: Organization | null) => {
    setCurrentOrgState(org);
    if (org) {
      localStorage.setItem("currentOrgId", String(org.id));
    } else {
      localStorage.removeItem("currentOrgId");
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<User> => {
      const response = await api.post<{ user: User }>("/api/auth/login", {
        email,
        password,
      });
      await mutate(response.user, false);
      if (response.user.organizations?.length) {
        setCurrentOrg(response.user.organizations[0]);
      }
      return response.user;
    },
    [mutate, setCurrentOrg],
  );

  const signup = useCallback(
    async (email: string, password: string): Promise<User> => {
      const response = await api.post<{ user: User }>("/api/auth/signup", {
        email,
        password,
      });
      await mutate(response.user, false);
      if (response.user.organizations?.length) {
        setCurrentOrg(response.user.organizations[0]);
      }
      return response.user;
    },
    [mutate, setCurrentOrg],
  );

  const logout = useCallback(async () => {
    await api.post("/api/auth/logout", {});
    setCurrentOrg(null);
    await mutate(undefined, false);
  }, [mutate, setCurrentOrg]);

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const stopImpersonation = useCallback(async () => {
    await api.post("/api/auth/stop-impersonation", {});
    await mutate();
  }, [mutate]);

  const value = useMemo(
    () => ({
      user: user ?? null,
      isLoading,
      error:
        error instanceof ApiError
          ? error
          : error
            ? new Error(String(error))
            : null,
      currentOrg,
      setCurrentOrg,
      login,
      signup,
      logout,
      refresh,
      stopImpersonation,
    }),
    [
      user,
      isLoading,
      error,
      currentOrg,
      setCurrentOrg,
      login,
      signup,
      logout,
      refresh,
      stopImpersonation,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
