"use client";

import { type ComponentPropsWithRef, forwardRef } from "react";
import { Slot } from "@radix-ui/react-slot";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
};

export const TooltipIconButton = forwardRef<
  HTMLButtonElement,
  TooltipIconButtonProps
>(({ tooltip, side = "bottom", children, ...rest }, ref) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button ref={ref} variant="ghost" size="icon" {...rest}>
        {children}
      </Button>
    </TooltipTrigger>
    <TooltipContent side={side}>{tooltip}</TooltipContent>
  </Tooltip>
));
TooltipIconButton.displayName = "TooltipIconButton";
