import { describe, it, expect, beforeEach } from 'vitest';
import { usePlaybackStore } from '../playbackStore';

describe('playbackStore', () => {
    beforeEach(() => {
        usePlaybackStore.setState({ cursorTime: null, isPlaying: false, speed: 1 });
    });

    it('has correct initial state', () => {
        const state = usePlaybackStore.getState();
        expect(state.cursorTime).toBeNull();
        expect(state.isPlaying).toBe(false);
        expect(state.speed).toBe(1);
    });

    it('setCursorTime updates cursorTime', () => {
        usePlaybackStore.getState().setCursorTime(1000);
        expect(usePlaybackStore.getState().cursorTime).toBe(1000);
    });

    it('setCursorTime accepts null', () => {
        usePlaybackStore.getState().setCursorTime(5000);
        usePlaybackStore.getState().setCursorTime(null);
        expect(usePlaybackStore.getState().cursorTime).toBeNull();
    });

    it('play/pause toggle isPlaying', () => {
        usePlaybackStore.getState().play();
        expect(usePlaybackStore.getState().isPlaying).toBe(true);
        usePlaybackStore.getState().pause();
        expect(usePlaybackStore.getState().isPlaying).toBe(false);
    });

    it('setSpeed updates speed', () => {
        usePlaybackStore.getState().setSpeed(2);
        expect(usePlaybackStore.getState().speed).toBe(2);
    });

    it('setSpeed accepts fractional values', () => {
        usePlaybackStore.getState().setSpeed(0.5);
        expect(usePlaybackStore.getState().speed).toBe(0.5);
    });

    it('cursor at end can be reset to start before playing', () => {
        usePlaybackStore.getState().setCursorTime(999_999);
        expect(usePlaybackStore.getState().cursorTime).toBe(999_999);
        usePlaybackStore.getState().setCursorTime(0); // what handlePlayPause does
        usePlaybackStore.getState().play();
        expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
});
