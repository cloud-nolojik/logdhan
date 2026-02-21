import { describe, it, expect, vi } from 'vitest';
import AIAnalyzeService from '../aiAnalyze.service.js';

describe('AIAnalyzeService', () => {
    it('should instantiate correctly and expose core methods', () => {
        expect(AIAnalyzeService).toBeDefined();

        // Check if the service exposed the expected methods
        expect(typeof AIAnalyzeService.formatMessagesForModel).toBe('function');
        expect(typeof AIAnalyzeService.buildRequestPayload).toBe('function');
        expect(typeof AIAnalyzeService.checkAnalysisLimits).toBe('function');
    });

    it('should correctly format messages for model (regular behavior)', () => {
        const systemPrompt = 'You are a helpful assistant.';
        const userPrompt = 'Please analyze this stock.';

        const result = AIAnalyzeService.formatMessagesForModel('gpt-4o', systemPrompt, userPrompt);

        expect(result).toHaveLength(2);
        expect(result[0].role).toBe('system');
        expect(result[1].role).toBe('user');
    });

    it('should correctly build request payload forcing JSON', () => {
        const mockModel = 'gpt-4o';
        const mockMessages = [{ role: 'user', content: 'hello' }];

        const payload = AIAnalyzeService.buildRequestPayload(mockModel, mockMessages, true);

        expect(payload.model).toBe(mockModel);
        expect(payload.messages).toEqual(mockMessages);
        expect(payload.response_format.type).toBe('json_object');
    });
});
