import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Outline look shared by the status-tinted variants (the mock's `.btn.danger`):
// only the text takes the color.
const OUTLINE = "border border-cx-border-strong bg-transparent hover:bg-cx-sub";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[7px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cx-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-cx-primary text-white hover:bg-cx-primary-hover",
        destructive: `${OUTLINE} text-cx-rose`,
        // The one place a solid red is right (delete confirmation).
        "destructive-solid":
          "bg-rose-700 text-white shadow-sm hover:bg-rose-800 dark:bg-rose-700 dark:hover:bg-rose-800",
        outline:
          "border border-cx-border-strong bg-transparent text-cx-fg2 hover:bg-cx-sub hover:text-cx-fg",
        secondary: "bg-cx-sub text-cx-fg hover:bg-cx-border",
        ghost: "text-cx-muted hover:bg-cx-sub hover:text-cx-fg",
        link: "text-cx-accent underline-offset-4 hover:underline",
        success: `${OUTLINE} text-cx-emerald`,
        warning: `${OUTLINE} text-cx-amber`,
        info: `${OUTLINE} text-cx-accent`,
      },
      size: {
        default: "h-8 px-3.5 text-[13px]",
        sm: "h-7 px-2.5 text-[12.5px]",
        lg: "h-10 px-8 text-sm",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
