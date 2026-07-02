// Map a keyboard key to a player action, or null. ctx.typingInInput guards
// against hijacking keys while the user types in a field.
export function keyToAction(key, ctx) {
  if (ctx && ctx.typingInInput) return null;
  switch (key) {
    case " ":
    case "k": return { type: "togglePlay" };
    case "ArrowLeft": return { type: "seekBy", delta: -10 };
    case "ArrowRight": return { type: "seekBy", delta: 10 };
    case "ArrowUp": return { type: "volumeBy", delta: 0.1 };
    case "ArrowDown": return { type: "volumeBy", delta: -0.1 };
    case "f": return { type: "toggleFullscreen" };
    case "m": return { type: "toggleMute" };
    case "c": return { type: "toggleCaptions" };
    default: return null;
  }
}
