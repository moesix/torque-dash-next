import { describe, it, expect } from 'vitest';
import * as api from '../api';

describe('api module', () => {
    it('exports expected functions', () => {
        expect(typeof api.getSessions).toBe('function');
        expect(typeof api.login).toBe('function');
        expect(typeof api.logout).toBe('function');
        expect(typeof api.register).toBe('function');
        expect(typeof api.getSession).toBe('function');
        expect(typeof api.getTelemetry).toBe('function');
        expect(typeof api.getSettings).toBe('function');
        expect(typeof api.updateSettings).toBe('function');
        expect(typeof api.generateUploadToken).toBe('function');
        expect(typeof api.renameSession).toBe('function');
        expect(typeof api.updateSessionNotes).toBe('function');
        expect(typeof api.updateLlmSettings).toBe('function');
        expect(typeof api.testLlmConnection).toBe('function');
        expect(typeof api.analyzeSession).toBe('function');
        expect(typeof api.listAnalyses).toBe('function');
        expect(typeof api.deleteAnalysis).toBe('function');
        expect(typeof api.exportSessionCsv).toBe('function');
        expect(typeof api.getVehicles).toBe('function');
        expect(typeof api.getVehicle).toBe('function');
        expect(typeof api.createVehicle).toBe('function');
        expect(typeof api.updateVehicle).toBe('function');
        expect(typeof api.deleteVehicle).toBe('function');
        expect(typeof api.setDefaultVehicle).toBe('function');
        expect(typeof api.reassignSessionVehicle).toBe('function');
        expect(typeof api.getVersion).toBe('function');
    });

    it('exports ApiError class', () => {
        expect(api.ApiError).toBeDefined();
        const err = new api.ApiError('test', 404);
        expect(err.message).toBe('test');
        expect(err.status).toBe(404);
        expect(err.name).toBe('ApiError');
        expect(err instanceof Error).toBe(true);
    });
});
