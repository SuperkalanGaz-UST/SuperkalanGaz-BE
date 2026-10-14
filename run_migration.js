const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  const sql = fs.readFileSync('migrations/0036_create_inventory_stock_check_logs.sql', 'utf8');
  await client.query(sql);
  console.log('Migration ran successfully');
  await client.end();
}
run().catch(console.error);
