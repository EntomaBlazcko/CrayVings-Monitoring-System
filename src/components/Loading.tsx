// =============================================================================
// FILE: src/components/Loading.tsx
// PURPOSE: Shared loading/error UI primitives used across all pages.
// =============================================================================

import { Loader2, AlertTriangle, RefreshCw } from "lucide-react";

export function Spinner({
  size = 16,
  className = "text-gray-500",
}: {
  size?: number;
  className?: string;
}) {
  return <Loader2 size={size} className={`animate-spin shrink-0 ${className}`} />;
}

export function LoadingCard({
  title,
  message = "Loading...",
  className = "",
}: {
  title?: string;
  message?: string;
  className?: string;
}) {
  return (
    <div
      className={`bg-white rounded-xl border border-gray-100 p-8 text-center shadow-sm ${className}`}
    >
      <Spinner size={40} className="mx-auto mb-3 text-orange-500" />
      {title && (
        <h3 className="text-lg font-bold text-gray-800 mb-1">{title}</h3>
      )}
      <p className="text-sm text-gray-500">{message}</p>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse bg-gray-200 rounded ${className}`} />
  );
}

export function ErrorCard({
  title = "Failed to load",
  message = "Something went wrong while loading this page.",
  detail,
  onRetry,
  retryLabel = "Retry",
  className = "",
}: {
  title?: string;
  message?: string;
  detail?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={`bg-white rounded-xl border border-red-100 p-8 text-center shadow-sm ${className}`}
      role="alert"
    >
      <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-3">
        <AlertTriangle size={28} className="text-red-500" />
      </div>
      <h3 className="text-lg font-bold text-gray-800 mb-1">{title}</h3>
      <p className="text-sm text-gray-500 max-w-md mx-auto">{message}</p>
      {detail && (
        <p className="text-xs text-gray-400 mt-2 break-words">{detail}</p>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-red-700 bg-red-50 border border-red-200 hover:bg-red-100 transition-colors"
        >
          <RefreshCw size={14} />
          {retryLabel}
        </button>
      )}
    </div>
  );
}

// Skeleton for a full table card (headers + rows), matching other list pages.
export function TableSkeleton({
  rows = 4,
  cols = 4,
  className = "",
}: {
  rows?: number;
  cols?: number;
  className?: string;
}) {
  return (
    <div
      className={`bg-white rounded-xl border border-gray-200 overflow-hidden ${className}`}
      aria-hidden="true"
    >
      <div className="bg-gray-50 border-b border-gray-200 px-4 py-3 flex gap-6">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-16" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="px-4 py-3.5 border-b border-gray-100 last:border-0 flex gap-6">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-3 ${c === cols - 1 ? "w-10" : "w-24"}`} />
          ))}
        </div>
      ))}
    </div>
  );
}
