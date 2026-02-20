import { pushSchema } from '../src/db/migrate.js';
import { db, schema } from '../src/db/index.js';

pushSchema();

const projects = db.select().from(schema.projects).all();
console.log('=== Projects ===');
console.log(JSON.stringify(projects, null, 2));

const markets = db.select().from(schema.markets).all();
console.log('\n=== Markets ===');
console.log(JSON.stringify(markets, null, 2));

const state = db.select().from(schema.indexerState).all();
console.log('\n=== Indexer State ===');
console.log(JSON.stringify(state, null, 2));

const tradeCount = db.select().from(schema.trades).all().length;
console.log('\nTrade count:', tradeCount);

const taxCount = db.select().from(schema.taxInflows).all().length;
console.log('Tax inflow count:', taxCount);
