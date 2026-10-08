'use strict';

/**
 * Módulo RANKING — rotas (v1.4.1).
 * Somente leitura agregada — ranking.view é a única permissão necessária.
 * A agregação de vendedores executa UMA vez por requisição; o summary é
 * derivado do mesmo resultado (sem dupla consulta).
 */

const express = require('express');
const { ok } = require('../../core/http');
const { optInt } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const service = require('./service');

const router = express.Router();

// Módulo exclusivo de tenants
router.use((req, res, next) => {
  if (tenantId(req) === null) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  }
  next();
});

router.get('/', requirePermission('ranking.view'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const p = service.parsePeriod(req.query);
    const store_id = optInt(req.query.store_id, 'Loja');
    const items = await service.sellerRanking(companyId, { ...p, store_id });
    // summary derivado do MESMO resultado — nenhuma segunda agregação
    return ok(res, { ...p, items, summary: service.summaryFromItems(items) });
  } catch (err) {
    next(err);
  }
});

router.get('/stores', requirePermission('ranking.view'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const p = service.parsePeriod(req.query);
    const items = await service.storeRanking(companyId, p);
    return ok(res, { ...p, items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
