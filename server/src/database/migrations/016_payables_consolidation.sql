-- ============================================================================
-- Migration 016 — Consolidação Contas a Pagar (v2.0.1)
-- Permissão própria de DELETE (não reutiliza payables.create).
-- ============================================================================

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('payables.delete', 'Contas a pagar', 'Excluir título manual em aberto');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'payables.delete' FROM roles r WHERE r.slug = 'company_admin';
