const EmbeddedPostgres = require('embedded-postgres').default;

async function main() {
  console.log('Starting Embedded PostgreSQL with UTF-8 encoding...');
  const pg = new EmbeddedPostgres({
    databaseDir: './.pgdata',
    port: 5432,
    user: 'postgres',
    password: 'password',
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C']
  });

  try {
    await pg.initialise();
    console.log('[pg] Cluster initialized with UTF-8.');
  } catch (err) {
    // Cluster may already be initialized
    console.log('[pg] Cluster already initialized or skipping init:', err.message);
  }

  await pg.start();
  console.log('[pg] PostgreSQL server running on port 5432 with UTF-8.');
}

main().catch(err => {
  console.error('[pg] Failed to start:', err);
  process.exit(1);
});
