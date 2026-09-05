import { describe, it, expect } from 'vitest';
import { stats } from '../SessionSummaryCard';

describe('stats', () => {
    it('returns null for empty input', () => {
        expect(stats([])).toBeNull();
    });

    it('returns null when all values are null', () => {
        expect(stats([null, null, null])).toBeNull();
    });

    it('returns the middle value for an odd count', () => {
        expect(stats([1, 2, 3])).toEqual({ min: 1, max: 3, median: 2 });
        expect(stats([5, 3, 1])).toEqual({ min: 1, max: 5, median: 3 });
    });

    it('returns the mean of the two middles for an even count', () => {
        expect(stats([1, 2, 3, 4])).toEqual({ min: 1, max: 4, median: 2.5 });
        expect(stats([4, 2, 1, 3])).toEqual({ min: 1, max: 4, median: 2.5 });
    });

    it('sorts unsorted input internally and ignores nulls', () => {
        expect(stats([30, null, 10, 20])).toEqual({ min: 10, max: 30, median: 20 });
        expect(stats([null, 7, 1, 5])).toEqual({ min: 1, max: 7, median: 5 });
    });
});
