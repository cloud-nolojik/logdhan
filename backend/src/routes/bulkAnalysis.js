import express from 'express';
import { auth } from '../middleware/auth.js';
import * as bulkController from '../controllers/bulkAnalysis.controller.js';

const router = express.Router();

/** @route POST /analyze-all */
router.post('/analyze-all', auth, bulkController.analyzeAll);

/** @route POST /cancel */
router.post('/cancel', auth, bulkController.cancelAnalysis);

/** @route GET /status */
router.get('/status', auth, bulkController.getStatus);

/** @route GET /strategies */
router.get('/strategies', auth, bulkController.getStrategies);

/** @route POST /reanalyze-stock */
router.post('/reanalyze-stock', auth, bulkController.reanalyzeStock);

/** @route GET /version */
router.get('/version', auth, bulkController.getVersion);

/** @route GET /debug/sessions */
router.get('/debug/sessions', auth, bulkController.debugSessions);

/** @route GET /timing-check */
router.get('/timing-check', auth, bulkController.timingCheck);

/** @route GET /analysis-details/:analysisId */
router.get('/analysis-details/:analysisId', auth, bulkController.getAnalysisDetails);

/** @route POST /record-order-placement */
router.post('/record-order-placement', auth, bulkController.recordOrderPlacement);

export default router;
