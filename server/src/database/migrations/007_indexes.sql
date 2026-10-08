-- ============================================================================
-- Migration 007 — Índices essenciais (v1.6)
-- Auditoria do módulo Clientes revelou consulta frequente sem índice:
-- histórico/contagem de vendas por cliente (WHERE company_id + customer_id).
-- Nenhum dado é alterado; apenas performance de leitura.
-- ============================================================================

CREATE INDEX IF NOT EXISTS ix_sales_company_customer
  ON sales(company_id, customer_id);
