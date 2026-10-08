-- ============================================================================
-- Migration 014 — Hardening de inventário (v1.9 final)
-- counted_at: momento da contagem (auditoria).
-- counted_movement_id: ID do último movimento de estoque EXISTENTE no momento
-- da contagem (empresa+loja+produto). Na finalização, o saldo de referência é
-- reconciliado somando os movimentos com id MAIOR — determinístico, sem
-- depender de precisão de relógio. Venda/recebimento/transferência/ajuste
-- ocorridos depois da contagem não são apagados nem duplicados.
-- ============================================================================

ALTER TABLE inventory_items ADD COLUMN counted_at TEXT;
ALTER TABLE inventory_items ADD COLUMN counted_movement_id INTEGER NOT NULL DEFAULT 0;
