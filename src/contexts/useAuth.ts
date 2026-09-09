// =============================================================================
// FILE: src/contexts/useAuth.ts
// =============================================================================
// Convenience hook to consume AuthContext with a safety check.
// =============================================================================

import { useContext } from "react";
import { AuthContext, type AuthContextType } from "./AuthContext";

// Provides auth state and throws if used outside AuthProvider.
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
