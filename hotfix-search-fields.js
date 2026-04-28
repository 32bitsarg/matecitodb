const { Client } = require('pg');

async function hotfix() {
  const client = new Client({
    host: 'localhost',
    user: 'matebase',
    password: 'matecitodb154921',
    database: 'matebase_console',
  });

  await client.connect();

  // 1. Get schema_name for etheria
  const projectRes = await client.query(
    "SELECT schema_name FROM projects WHERE subdomain = 'etheria' LIMIT 1"
  );

  if (!projectRes.rows[0]) {
    console.log('❌ Project etheria not found');
    await client.end();
    return;
  }

  const schema = projectRes.rows[0].schema_name;
  console.log(`🔧 Fixing schema: ${schema}`);

  // 2. Add missing columns
  await client.query(`
    ALTER TABLE "${schema}"._records
    ADD COLUMN IF NOT EXISTS search_vector tsvector
  `);
  console.log('✅ Added search_vector to _records');

  await client.query(`
    ALTER TABLE "${schema}"._collections
    ADD COLUMN IF NOT EXISTS search_fields TEXT[]
  `);
  console.log('✅ Added search_fields to _collections');

  // 3. Create GIN index
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${schema}_records_search_vector_idx
    ON "${schema}"._records USING gin(search_vector)
  `).catch(() => {});
  console.log('✅ Created GIN index on search_vector');

  // 4. Also fix any other projects that might be missing these columns
  const allProjects = await client.query(
    "SELECT schema_name FROM projects WHERE schema_name IS NOT NULL"
  );

  for (const { schema_name } of allProjects.rows) {
    if (schema_name === schema) continue; // already fixed
    try {
      await client.query(`
        ALTER TABLE "${schema_name}"._records
        ADD COLUMN IF NOT EXISTS search_vector tsvector
      `);
      await client.query(`
        ALTER TABLE "${schema_name}"._collections
        ADD COLUMN IF NOT EXISTS search_fields TEXT[]
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${schema_name}_records_search_vector_idx
        ON "${schema_name}"._records USING gin(search_vector)
      `).catch(() => {});
      console.log(`✅ Fixed schema: ${schema_name}`);
    } catch (err) {
      console.log(`⚠️  Could not fix ${schema_name}: ${err.message}`);
    }
  }

  await client.end();
  console.log('\n🎉 Hotfix complete!');
}

hotfix().catch(console.error);
