"use client";

import { memo } from "react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { inlineSvgBlocks } from "../../lib/svg-inline";

export const MarkdownText = memo(function MarkdownText() {
  return (
    <StreamdownTextPrimitive
      plugins={{ code, mermaid }}
      shikiTheme={["github-light", "github-dark"]}
      preprocess={inlineSvgBlocks}
      defer
    />
  );
});
