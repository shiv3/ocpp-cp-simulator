import React, { useMemo } from "react";

import { tokenizeJson } from "../lib/jsonHighlight";

/** JSON text as `cx-json-<kind>` spans (colors in TraceView.css); text it
 *  does not recognize is rendered as is. */
export const JsonHighlight: React.FC<{ text: string }> = ({ text }) => {
  const tokens = useMemo(() => tokenizeJson(text), [text]);
  return (
    <>
      {tokens.map((token, i) =>
        token.kind === "text" ? (
          token.text
        ) : (
          <span key={i} className={`cx-json-${token.kind}`}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
};
