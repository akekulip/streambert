// Pure reducer for the native player's UI state. The hook (useVideoController)
// subscribes to the <video> element's events and dispatches these.
export const initialVideoState = {
  playing: false,
  current: 0,
  duration: 0,
  bufferedEnd: 0,
  volume: 1,
  muted: false,
  ready: false,
  ended: false,
};

export function reduceVideo(state, event) {
  switch (event.type) {
    case "play": return { ...state, playing: true, ended: false };
    case "pause": return { ...state, playing: false };
    case "time": return { ...state, current: event.current };
    case "duration": return { ...state, duration: event.duration, ready: true };
    case "buffered": return { ...state, bufferedEnd: event.bufferedEnd };
    case "volume": return { ...state, volume: event.volume, muted: event.muted };
    case "ended": return { ...state, playing: false, ended: true };
    default: return state;
  }
}
