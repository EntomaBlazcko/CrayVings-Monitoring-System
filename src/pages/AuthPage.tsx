// =============================================================================
// FILE: src/pages/AuthPage.tsx
// =============================================================================
// PURPOSE: Login/authentication page for the CRAYvings Monitoring System.
//
// This page:
//   1. Displays the login form with username and password fields
//   2. Validates input using Zod schema (min length, format checks)
//   3. Calls the backend API via AuthContext's login function
//   4. Shows loading spinner during authentication
//   5. Displays validation errors and API error messages
//   6. Supports password visibility toggle
//
// AUTH FLOW:
//   User enters credentials -> Zod validation -> API call -> Token stored
//   -> AuthContext updates user state -> App.tsx redirects to DashboardLayout
//
// DEFAULT CREDENTIALS (created by server on first startup):
//   Username: admin
//   Password: Admin@123
// =============================================================================

import { useState, useCallback } from "react";
import { z } from "zod";
import { Eye, EyeOff, User, Lock, LogIn } from "lucide-react";
import { useAuth } from "../contexts/useAuth";
import logo from "../assets/crayvings.png";

// ========================
// LOGIN FORM VALIDATION SCHEMA
// ========================
// Zod schema for validating login form input.
// Username: 3-50 characters
// Password: 6-100 characters
const loginSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters").max(50),
  password: z.string().min(6, "Password must be at least 6 characters").max(100),
});

type LoginForm = z.infer<typeof loginSchema>;
type FormErrors = Record<string, string>;

/**
 * Login page component with form validation and API authentication.
 * Displays the app branding, login form, and error messages.
 * On successful login, the AuthContext updates and redirects to the dashboard.
 */
export default function AuthPage() {
  const { login, isLoading, clearError } = useAuth();
  const [showPassword, setShowPassword] = useState(false);

  const [loginForm, setLoginForm] = useState<LoginForm>({
    username: "",
    password: "",
  });
  const [loginErrors, setLoginErrors] = useState<FormErrors>({});
  const [apiError, setApiError] = useState<string | null>(null);

  /**
   * Validates the login form against the Zod schema.
   * Returns an object of field-specific error messages.
   */
  const validateLoginForm = useCallback((): FormErrors => {
    try {
      loginSchema.parse(loginForm);
      return {};
    } catch (err) {
      if (err instanceof z.ZodError) {
        const errors: FormErrors = {};
        err.issues.forEach((e) => {
          if (e.path[0]) {
            errors[e.path[0] as string] = e.message;
          }
        });
        return errors;
      }
      return { general: "Invalid form data" };
    }
  }, [loginForm]);

  /**
   * Handles form submission.
   * Validates input, clears previous errors, attempts login.
   * On failure, displays the error message to the user.
   */
  const handleLoginSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setApiError(null);

    const errors = validateLoginForm();
    setLoginErrors(errors);

    if (Object.keys(errors).length === 0) {
      try {
        await login(loginForm.username, loginForm.password);
      } catch (err: unknown) {
        if (err instanceof Error && err.message) {
          setApiError(err.message);
        } else {
          setApiError("Invalid username or password. Please try again.");
        }
      }
    }
  }, [loginForm, validateLoginForm, login, clearError]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-white to-orange-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Login card */}
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          {/* Card header with branding */}
          <div className="bg-gradient-to-r from-[#d94b1e] to-[#ef6a2e] p-6 text-center text-white">
            <div className="w-20 h-20 mx-auto rounded-full bg-white flex items-center justify-center overflow-hidden border-2 border-white/50 mb-3">
              <img src={logo} alt="CrayVings Logo" className="w-full h-full object-contain" />
            </div>
            <h1 className="text-2xl font-extrabold">CRAYvings Monitoring System</h1>
            <p className="text-sm opacity-90 mt-1">Smart aquaculture monitoring dashboard</p>
          </div>

          {/* Login form */}
          <div className="p-6">
            {/* API error message display */}
            {(apiError) && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
                {apiError}
              </div>
            )}

            <form onSubmit={handleLoginSubmit} className="space-y-4" noValidate>
              {/* Username field */}
              <div>
                <label htmlFor="login-username" className="block text-sm font-medium text-gray-700 mb-1">
                  Username
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                    <User size={18} />
                  </div>
                  <input
                    id="login-username"
                    type="text"
                    value={loginForm.username}
                    onChange={(e) => {
                      setLoginForm((prev) => ({ ...prev, username: e.target.value }));
                      if (loginErrors.username) setLoginErrors((prev) => ({ ...prev, username: "" }));
                      if (apiError) setApiError(null);
                    }}
                    className={`w-full pl-10 pr-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#d94b1e]/20 focus:border-[#d94b1e] transition-colors ${
                      loginErrors.username ? "border-red-500 bg-red-50" : "border-gray-300"
                    }`}
                    placeholder="Enter your username"
                    autoComplete="username"
                  />
                </div>
                {loginErrors.username && (
                  <p className="mt-1 text-xs text-red-600">{loginErrors.username}</p>
                )}
              </div>

              {/* Password field with visibility toggle */}
              <div>
                <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 mb-1">
                  Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                    <Lock size={18} />
                  </div>
                  <input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    value={loginForm.password}
                    onChange={(e) => {
                      setLoginForm((prev) => ({ ...prev, password: e.target.value }));
                      if (loginErrors.password) setLoginErrors((prev) => ({ ...prev, password: "" }));
                      if (apiError) setApiError(null);
                    }}
                    className={`w-full pl-10 pr-10 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#d94b1e]/20 focus:border-[#d94b1e] transition-colors ${
                      loginErrors.password ? "border-red-500 bg-red-50" : "border-gray-300"
                    }`}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                {loginErrors.password && (
                  <p className="mt-1 text-xs text-red-600">{loginErrors.password}</p>
                )}
              </div>

              {/* Submit button with loading spinner */}
              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-gradient-to-r from-[#d94b1e] to-[#ef6a2e] text-white py-2.5 rounded-lg font-semibold hover:from-[#c2410c] hover:to-[#d94b1e] focus:outline-none focus:ring-2 focus:ring-[#d94b1e]/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <LogIn size={18} />
                    Sign In
                  </>
                )}
              </button>
            </form>

            <p className="text-center text-xs text-gray-400 mt-6">
              Contact your administrator for account credentials
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-gray-500 mt-4">
          Smart aquaculture monitoring for sustainable crayfish farming
        </p>
      </div>
    </div>
  );
}
