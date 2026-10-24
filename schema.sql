-- ABUM UPGRADE D1 schema
-- One generic document table lets the initial migration preserve the appusers,
-- appsettings, apppromocodes, appwithdrawals and appsecurityaudit collection shapes.
CREATE TABLE IF NOT EXISTS abum_documents (
  collection TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, doc_key)
);
CREATE INDEX IF NOT EXISTS idx_abum_documents_collection_updated
  ON abum_documents (collection, updated_at DESC);
