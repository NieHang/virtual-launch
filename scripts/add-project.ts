import { pushSchema } from '../src/db/migrate.js'
import { db, schema } from '../src/db/index.js'
import { getClient } from '../src/chain/client.js'
import { TOKEN_ABI } from '../src/chain/constants.js'
import { type Address, getAddress } from 'viem'

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length < 1) {
    console.log('Usage: npm run add-project <token_address> [name]')
    console.log('')
    console.log('Example:')
    console.log('  npm run add-project 0x1234...abcd "My Token"')
    process.exit(1)
  }

  const tokenAddress = getAddress(args[0]) as Address
  const providedName = args[1]

  // Push schema first
  pushSchema()

  console.log(`Adding project for token: ${tokenAddress}`)

  // Try to read token metadata
  const client = getClient()
  let name = providedName || 'Unknown Token'
  let symbol = ''

  try {
    name =
      providedName ||
      ((await client.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: 'name',
      })) as string)
  } catch {}

  try {
    symbol = (await client.readContract({
      address: tokenAddress,
      abi: TOKEN_ABI,
      functionName: 'symbol',
    })) as string
  } catch {}

  if (symbol && !providedName) {
    name = `${name} (${symbol})`
  }

  // Generate a simple ID from address
  const id = tokenAddress.toLowerCase().slice(2, 10)

  // Check if already exists
  const existing = db
    .select()
    .from(schema.projects)
    .all()
    .find((p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())

  if (existing) {
    console.log(`Project already exists: ${existing.id} (${existing.name})`)
    process.exit(0)
  }

  // Insert project
  db.insert(schema.projects)
    .values({
      id,
      name,
      tokenAddress: getAddress(tokenAddress),
      virtualAddress: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
      phase: 'INTERNAL',
      createdAt: Math.floor(Date.now() / 1000),
    })
    .run()

  console.log(`Project created successfully!`)
  console.log(`  ID: ${id}`)
  console.log(`  Name: ${name}`)
  console.log(`  Token: ${tokenAddress}`)
  console.log('')
  console.log('Now run `npm run dev` to start the indexer and API server.')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})

