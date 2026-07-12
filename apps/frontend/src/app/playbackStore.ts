import { create } from 'zustand';

export interface PlaybackState {
  /** Epoch-ms timestamp the playback cursor currently points at. */
  cursorTime: number | null;
  isPlaying: boolean;
  /** Playback speed multiplier. */
  speed: number;
  setCursorTime: (t: number | null) => void;
  play: () => void;
  pause: () => void;
  setSpeed: (s: number) => void;
}

/**
 * Global playback state shared across the ECharts time-series charts, the GPS
 * map marker, and the scrubber. Components subscribe imperatively (via
 * `usePlaybackStore.subscribe`) so that moving the cursor does NOT re-render the
 * React tree — in particular the react-leaflet <MapContainer> must stay mounted.
 */
export const usePlaybackStore = create<PlaybackState>((set) => ({
  cursorTime: null,
  isPlaying: false,
  speed: 1,
  setCursorTime: (t) => set({ cursorTime: t }),
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  setSpeed: (s) => set({ speed: s }),
}));
