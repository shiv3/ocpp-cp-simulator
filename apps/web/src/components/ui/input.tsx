import * as React from "react";

import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-[7px] border border-cx-border bg-cx-card px-2.5 py-1.5 text-[13px] text-cx-fg transition-colors file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-cx-fg placeholder:text-cx-faint hover:border-cx-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cx-accent disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
