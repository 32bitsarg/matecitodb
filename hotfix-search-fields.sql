-- ═══════════════════════════════════════════════════════════════════════════════
-- HOTFIX: Agregar columnas de full-text search a proyectos existentes
-- Ejecutar en PostgreSQL del VPS donde corre matecito.dev
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Obtener todos los schemas de proyectos existentes
DO $$
DECLARE
    project_schema TEXT;
BEGIN
    FOR project_schema IN
        SELECT schema_name FROM projects WHERE schema_name IS NOT NULL
    LOOP
        RAISE NOTICE 'Fixing schema: %', project_schema;

        -- Agregar search_vector a _records (si no existe)
        EXECUTE format('
            ALTER TABLE %I._records
            ADD COLUMN IF NOT EXISTS search_vector tsvector
        ', project_schema);

        -- Agregar search_fields a _collections (si no existe)
        EXECUTE format('
            ALTER TABLE %I._collections
            ADD COLUMN IF NOT EXISTS search_fields TEXT[]
        ', project_schema);

        -- Crear índice GIN en search_vector (si no existe)
        EXECUTE format('
            CREATE INDEX IF NOT EXISTS %I_records_search_vector_idx
            ON %I._records USING gin(search_vector)
        ', project_schema, project_schema);

        RAISE NOTICE 'Schema % fixed', project_schema;
    END LOOP;
END $$;

-- Verificar que el schema de etheria quedó correcto
SELECT
    c.relname AS table_name,
    a.attname AS column_name,
    t.typname AS data_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid
JOIN pg_type t ON t.oid = a.atttypid
WHERE c.relname IN ('_records', '_collections')
  AND a.attname IN ('search_vector', 'search_fields')
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND n.nspname = (SELECT schema_name FROM projects WHERE subdomain = 'etheria')
ORDER BY c.relname, a.attname;
