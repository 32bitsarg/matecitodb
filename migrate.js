/**
 * migrate.js — Migración para proyectos existentes
 *
 * Aplica los cambios de schema a todos los proyectos ya creados en la DB.
 * Es seguro correrlo múltiples veces (usa IF NOT EXISTS / IF EXISTS).
 *
 * Uso:
 *   node migrate.js
 */

const { db } = require('./lib/matecito')

async function migrate() {
  console.log('🧉 matecito migrate — iniciando\n')

  // Obtener todos los proyectos con su schema_name
  const { rows: projects } = await db.query(
    `SELECT id, name, schema_name FROM projects ORDER BY created_at ASC`
  )

  if (projects.length === 0) {
    console.log('No hay proyectos en la base de datos.')
    process.exit(0)
  }

  console.log(`Encontrados ${projects.length} proyecto(s):\n`)

  for (const project of projects) {
    const s = `"${project.schema_name}"`
    console.log(`▶ ${project.name} (${project.schema_name})`)

    try {
      // ── 1. _auth_users: agregar email_verified y email_verified_at ──────────
      await db.query(`
        ALTER TABLE ${s}._auth_users
          ADD COLUMN IF NOT EXISTS email_verified    BOOLEAN   NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP DEFAULT NULL
      `)
      console.log('  ✓ _auth_users: email_verified, email_verified_at')

      // ── 2. _permissions: agregar filter_rule ────────────────────────────────
      await db.query(`
        ALTER TABLE ${s}._permissions
          ADD COLUMN IF NOT EXISTS filter_rule TEXT DEFAULT NULL
      `)
      console.log('  ✓ _permissions: filter_rule')

      // ── 3. _records: agregar deleted_at ─────────────────────────────────────
      await db.query(`
        ALTER TABLE ${s}._records
          ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL
      `)
      // Índice para soft-delete eficiente
      await db.query(`
        CREATE INDEX IF NOT EXISTS ${project.schema_name}_records_deleted_idx
        ON ${s}._records(deleted_at)
        WHERE deleted_at IS NOT NULL
      `)
      console.log('  ✓ _records: deleted_at + índice')

      // ── 4. _smtp_config: crear tabla si no existe ────────────────────────────
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${s}._smtp_config (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          host          TEXT NOT NULL,
          port          INT  NOT NULL DEFAULT 587,
          secure        BOOLEAN NOT NULL DEFAULT false,
          smtp_user     TEXT NOT NULL,
          smtp_password TEXT NOT NULL DEFAULT '',
          from_name     TEXT NOT NULL DEFAULT '',
          from_email    TEXT NOT NULL,
          created_at    TIMESTAMP DEFAULT NOW(),
          updated_at    TIMESTAMP DEFAULT NOW()
        )
      `)
      console.log('  ✓ _smtp_config: tabla creada')

      console.log(`  ✅ ${project.name} — OK\n`)
    } catch (err) {
      console.error(`  ❌ ${project.name} — ERROR: ${err.message}\n`)
    }
  }

  console.log('✅ Migración completada.')
  await db.end()
}

migrate().catch(err => {
  console.error('Error fatal:', err)
  process.exit(1)
})
