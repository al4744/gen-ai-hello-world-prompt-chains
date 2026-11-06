"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { getServerTheme, getTheme, setTheme, subscribeTheme } from "@/lib/theme";

const options = [
  { value: "light", label: "Light mode" },
  { value: "dark", label: "Dark mode" },
  { value: "system", label: "System default" },
] as const;

export default function ThemeSelector() {
  const groupName = useId();
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);
  const [saveFailed, setSaveFailed] = useState(false);

  return (
    <div className="min-w-0">
      <fieldset className="theme-switcher">
        <legend className="sr-only">Theme preference</legend>
        {options.map(({ value, label }) => (
          <label key={value} className="theme-option" title={label}>
            <input
              type="radio"
              name={groupName}
              value={value}
              checked={theme === value}
              onChange={() => setSaveFailed(!setTheme(value))}
              className="sr-only"
            />
            <span className="theme-option-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                {value === "light" ? (
                  <>
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
                  </>
                ) : value === "dark" ? (
                  <path d="M20.9 13.1A9 9 0 0 1 10.9 3.1a9 9 0 1 0 10 10Z" />
                ) : (
                  <>
                    <rect x="4" y="4" width="16" height="12" rx="2" />
                    <path d="m4 16-2 4h20l-2-4" />
                  </>
                )}
              </svg>
            </span>
            <span className="sr-only">{label}</span>
          </label>
        ))}
      </fieldset>
      {saveFailed && (
        <p role="status" className="mt-2 text-xs leading-5 text-muted">
          Your browser could not save this preference. It applies to this tab until you reload.
        </p>
      )}
    </div>
  );
}
