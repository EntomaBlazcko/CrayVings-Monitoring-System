import { createContext, useState, useCallback, useEffect, type ReactNode } from "react";
import type { AuthUser } from "../types";
import { loginUser, logoutUser } from "../api/client";

const TOKEN_KEY = "crayvings_token";
const USER_KEY = "crayvings_user";

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

// Corrupted localStorage user JSON is discarded rather than crashing boot.
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

// The session token lives in localStorage (XSS-exposed, but acceptable here:
// the server validates it on every protected request and regenerates it per
// login).
export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const savedUser = getStoredUser();
    const savedToken = getStoredToken();
    return savedUser && savedToken ? savedUser : null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Server-side revoke is fire-and-forget; local state clears immediately.
  const logout = useCallback(() => {
    void logoutUser();
    setUser(null);
    setStoredUser(null);
    setStoredToken(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // The axios interceptor dispatches "crayvings_unauthorized" when the server
  // reports an expired/invalid session; drop local state so the app returns to
  // the login screen instead of showing a stuck error card.
  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      setStoredUser(null);
      setStoredToken(null);
    };
    window.addEventListener("crayvings_unauthorized", onUnauthorized);
    return () => window.removeEventListener("crayvings_unauthorized", onUnauthorized);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, error, login, logout, clearError }}>
      {children}
    </AuthContext.Provider>
  );
}
