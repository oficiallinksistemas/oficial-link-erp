-- ============================================================================
-- Migration 005 — Módulo Ranking (v1.4)
-- O Ranking é DERIVADO de vendas + metas — nenhuma tabela própria é criada
-- (sem duplicação de dados; consultas agregadas com GROUP BY + índices).
-- Aqui entram apenas as permissões para bancos legados (Master não precisa —
-- autoridade global do backend; bancos novos recebem o mesmo via seed.js).
-- ============================================================================

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('ranking.view', 'Ranking', 'Visualizar ranking de vendedores e lojas');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'ranking.view' FROM roles r
  WHERE r.slug IN ('company_admin', 'supervisor', 'seller');

-- O módulo 'ranking' já está registrado na tabela modules (migration 003).
-- Empresas existentes: opt-in pelo Master em Plataforma > Empresas (padrão
-- adotado desde a v1.3 — instalações existentes não mudam de comportamento).
