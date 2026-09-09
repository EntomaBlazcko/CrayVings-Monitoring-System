// =============================================================================
// FILE: src/contexts/AuthContext.tsx
// =============================================================================
// PURPOSE: Authentication context provider for managing user login state,
// with localStorage persistence and login/logout flows.
// =============================================================================

import { createContext, useState, useCallback, type ReactNode } from "react";
import type { AuthUser } from "../types";
import { loginUser, logoutUser } from "../api/client";

// ========================
// LOCAL STORAGE KEYS
// ========================
const TOKEN_KEY = "crayvings_token";
const USER_KEY = "crayvings_user";

// ========================
// CONTEXT TYPE DEFINITION
// ========================
export interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  clearError: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextType | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

// ========================
// LOCAL STORAGE HELPERS
// ========================

function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setStoredToken(token: string | null) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

// Handles corrupted localStorage data gracefully by removing it
function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    localStorage.removeItem(USER_KEY);
    return null;
  }
}

function setStoredUser(user: AuthUser | null) {
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_KEY);
  }
}

// ========================
// AUTH PROVIDER COMPONENT
// ========================

// Token stored in localStorage; vulnerable to XSS but acceptable for this app.
// Server-side validation on every protected request; token regenerated per login.
export function AuthProvider({ children }: AuthProviderProps) {
  // Restores session from localStorage on page refresh
  const [user, setUser] = useState<AuthUser | null>(() => {
    const savedUser = getStoredUser();
    const savedToken = getStoredToken();
    return savedUser && savedToken ? savedUser : null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Authenticates via API, stores token/user, re-throws for caller to display
  const login = useCallback(async (username: string, password: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await loginUser(username, password);
      setUser(response.user);
      setStoredUser(response.user);
      setStoredToken(response.token);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message || "Login failed");
      } else {
        setError("Login failed");
      }
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Revokes token server-side (fire-and-forget), clears local auth state
  const logout = useCallback(() => {
    void logoutUser();
    setUser(null);
    setStoredUser(null);
    setStoredToken(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, error, login, logout, clearError }}>
      {children}
    </AuthContext.Provider>
  );
}
