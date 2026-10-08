'use strict';

/**
 * Módulo de funções (roles) — leitura para montagem de selects e telas.
 * Master vê tudo; tenants nunca veem a função "master".
 */

const express = require('express');
const db = require('../../database/connection');
const { ok } = require('../../core/http');

const router = express.Router();

router.get('/', async (req, res) => {
  const isMaster = req.auth.user.companyId === null && req.auth.role.slug === 'master';
  const roles = db
    .prepare(
      `SELECT id, slug, name, description FROM roles
       WHERE company_id IS NULL ${isMaster ? '' : "AND slug != 'master'"}
       ORDER BY CASE slug WHEN 'company_admin' THEN 0 WHEN 'supervisor' THEN 1 WHEN 'seller' THEN 2 ELSE 9 END`
    )
    .all();
  const perms = await db.prepare('SELECT role_id, permission_code FROM role_permissions').all();
  const byRole = {};
  for (const p of perms) {
    (byRole[p.role_id] ||= []).push(p.permission_code);
  }
  return ok(res, roles.map((r) => ({ ...r, permissions: byRole[r.id] || [] })));
});

module.exports = router;
