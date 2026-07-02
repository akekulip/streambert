import { useEffect } from "react";
import { keyToAction } from "./keymap.mjs";

const isTyping = (el) =>
  !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

export function useKeyboardShortcuts({ active, actions }) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      const action = keyToAction(e.key, { typingInInput: isTyping(document.activeElement) });
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case "togglePlay": return actions.togglePlay();
        case "seekBy": return actions.seekBy(action.delta);
        case "volumeBy": return actions.volumeBy(action.delta);
        case "toggleFullscreen": return actions.toggleFullscreen();
        case "toggleMute": return actions.toggleMute();
        case "toggleCaptions": return actions.toggleCaptions();
        default: return undefined;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, actions]);
}
