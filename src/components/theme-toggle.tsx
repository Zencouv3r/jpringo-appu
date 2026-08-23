"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { useTheme } from "@/hooks/use-theme";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

interface ThemeToggleProps {
  theme: ReturnType<typeof useTheme>;
  /** For placement over dark video chrome, where the default button styling
   * would be invisible against the black player background. */
  variant?: "default" | "onDark";
}

export function ThemeToggle({ theme, variant = "default" }: ThemeToggleProps) {
  const ActiveIcon = OPTIONS.find((o) => o.value === theme.theme)?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Change theme"
                  className={cn(
                    variant === "onDark" && "text-white hover:bg-white/15 hover:text-white",
                  )}
                />
              }
            />
          }
        >
          <ActiveIcon className="size-4" />
        </TooltipTrigger>
        <TooltipContent>Theme: {theme.theme}</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem key={value} onClick={() => theme.setTheme(value)}>
            <Icon className="size-4" />
            {label}
            {theme.theme === value && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
