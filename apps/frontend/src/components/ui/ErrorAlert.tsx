interface ErrorAlertProps {
  message: string;
  onRetry?: () => void;
}

export default function ErrorAlert({ message, onRetry }: ErrorAlertProps) {
  return (
    <div className="rounded-md bg-red-50 p-4 dark:bg-red-900/20">
      <div className="flex items-start gap-3">
        {/* Error icon */}
        <svg
          className="h-5 w-5 shrink-0 text-red-500 mt-0.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <div className="flex-1">
          <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 text-sm font-medium text-red-600 hover:text-red-500 dark:text-red-400"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
