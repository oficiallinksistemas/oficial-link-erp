-- ============================================================================
-- Migration 018 — Personalização da identidade visual por empresa (v3.1)
-- Branding fica em companies.settings (JSON existente — sem tabela duplicada):
--   branding.display_name, branding.primary_color, branding.secondary_color,
--   branding.accent_color. Logotipo em company_assets (BLOB no SQLite —
--   persistência garantida em qualquer deploy, sem filesystem).
-- ============================================================================

CREATE TABLE IF NOT EXISTS company_assets (
  company_id  INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  mime        TEXT    NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  data        BLOB    NOT NULL,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
