// =============================================================================
// FILE: src/contexts/AuthContext.tsx
// =============================================================================
// PURPOSE: Authentication context provider for managing user login state.
//
// This file provides:
//   - AuthContext: React context that holds the authenticated user's state
//   - AuthProvider: Component that wraps the app and manages login/logout
//   - localStorage persistence: Token and user info survive page refreshes
//   - Login flow: Validates credentials via API, stores token, updates state
//   - Logout flow: Clears all auth data from state and localStorage
//
// SESSION MANAGEMENT:
//   - Token is stored in localStorage under "crayvings_token"
//   - User info is stored in localStorage under "crayvings_user"
//   - The API client's request interceptor automatically attaches the token
//   - On page refresh, the stored user/token is restored automatically
//
// SECURITY NOTES:
//   - Token is stored in localStorage (vulnerable to XSS but sufficient for this app)
//   - Server-side token validation occurs on every protected API request
//   - Token is regenerated on each login (old tokens become invalid)
// =============================================================================

import { createContext, useState, useCallback, type ReactNode } from "react";
import type { AuthUser } from "../types";
import { loginUser, logoutUser } from "../api/client";

// ========================
// LOCAL STORAGE KEYS
// ========================
// Keys used to store authentication data in the browser.
const TOKEN_KEY = "crayvings_token";
const USER_KEY = "crayvings_user";

// ========================
// CONTEXT TYPE DEFINITION
// ========================
/**
 * Interface for the authentication context value.
 * Provided to all child components via AuthContext.Provider.
 */
export interface AuthContextType {
  user: AuthUser | null;         // Current authenticated user (null if logged out)
  isLoading: boolean;            // True during login API call
  error: string | null;          // Login error message (null if no error)
  login: (username: string, password: string) => Promise<void>;  // Login function
  logout: () => void;            // Logout function
  clearError: () => void;        // Clears the error message
}

// Create the context with null as default value.
// The useAuth hook throws if accessed outside AuthProvider.
// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextType | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

// ========================
// LOCAL STORAGE HELPERS
// ========================
// Utility functions for reading/writing auth data to localStorage.

/** Retrieves the stored auth token from localStorage, or null if not found. */
function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Stores or removes the auth token in localStorage. */
function setStoredToken(token: string | null) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

/**
 * Retrieves the stored user object from localStorage.
 * Handles JSON parsing errors gracefully (e.g., corrupted data).
 */
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

/** Stores or removes the user object in localStorage. */
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
/**
 * Context provider that manages authentication state for the entire app.
 * Initializes state from localStorage on mount for session persistence.
 * Provides login, logout, and error management functions to children.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  // Initialize user state from localStorage (restores session on page refresh)
  const [user, setUser] = useState<AuthUser | null>(() => {
    const savedUser = getStoredUser();
    const savedToken = getStoredToken();
    return savedUser && savedToken ? savedUser : null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Authenticates a user with username and password.
   * Calls the backend API, stores the returned token and user info,
   * and updates the React state.
   * Re-throws errors so the calling component (AuthPage) can display them.
   */
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

  /**
   * Logs out the current user.
   * Revokes the token server-side (fire-and-forget), clears all authentication
   * state from React and localStorage.
   * The app will redirect to the login page (handled by AppContent in App.tsx).
   */
  const logout = useCallback(() => {
    void logoutUser();
    setUser(null);
    setStoredUser(null);
    setStoredToken(null);
  }, []);

  /** Clears any displayed login error message. */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, error, login, logout, clearError }}>
      {children}
    </AuthContext.Provider>
  );
}
