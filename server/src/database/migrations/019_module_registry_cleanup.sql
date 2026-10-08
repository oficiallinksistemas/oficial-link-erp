-- ============================================================================
-- Migration 019 — Limpeza do registry de módulos (v3.2)
-- A migration 003 registrou o slug 'goals' como placeholder do módulo Metas;
-- a migration 004 consolidou o módulo com o slug canônico 'targets' (tabela,
-- permissões targets.*, rotas /api/targets, frontend). O registro 'goals'
-- ficou ÓRFÃO: nenhum código, seed, permissão ou company_modules o referencia.
-- Removemos o órfão para que a UI de módulos da plataforma não exiba um
-- módulo fantasma. Nenhum dado real é afetado (nunca houve dados em 'goals').
-- ============================================================================

DELETE FROM company_modules WHERE module_slug = 'goals';
DELETE FROM modules WHERE slug = 'goals';
