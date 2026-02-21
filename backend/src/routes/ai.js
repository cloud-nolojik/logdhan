import express from 'express';
import { auth as authenticateToken } from '../middleware/auth.js';
import * as aiController from '../controllers/ai.controller.js';

const router = express.Router();

/** @route POST /analyze-stock */
router.post('/analyze-stock', authenticateToken, /* analysisRateLimit, */ aiController.analyzeStock);

/** @route GET /analysis-history */
router.get('/analysis-history', authenticateToken,  aiController.getAnalysisHistory);

/** @route GET /analysis/:analysisId */
router.get('/analysis/:analysisId', authenticateToken,  aiController.getAnalysisById);

/** @route GET /analysis/by-instrument/:instrumentKey */
router.get('/analysis/by-instrument/:instrumentKey', authenticateToken,  aiController.getAnalysisByInstrument);

/** @route GET /stats */
router.get('/stats', authenticateToken,  aiController.getStats);

/** @route DELETE /analysis/:analysisId */
router.delete('/analysis/:analysisId', authenticateToken,  aiController.deleteAnalysis);

/** @route GET /analysis/:analysisId/progress */
router.get('/analysis/:analysisId/progress', authenticateToken,  aiController.getAnalysisProgress);

/** @route GET /cache/stats */
router.get('/cache/stats', authenticateToken,  aiController.getCacheStats);

/** @route POST /analysis/delete */
router.post('/analysis/delete', authenticateToken,  aiController.deleteAnalysisManual);

/** @route GET /cache/info/:instrument_key */
router.get('/cache/info/:instrument_key', authenticateToken,  aiController.getCacheInfo);

/** @route GET /health */
router.get('/health',  aiController.checkHealth);

/** @route POST /evaluate-missed-entry */
router.post('/evaluate-missed-entry', authenticateToken,  aiController.evaluateMissedEntry);

export default router;
