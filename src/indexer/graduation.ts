import { type Address, getAddress } from 'viem'
import { getClient } from '../chain/client.js'
import { TOKEN_ABI, UNISWAP_V2_PAIR_ABI } from '../chain/constants.js'
import { isContract } from '../chain/utils.js'

export interface GraduationResult {
  graduated: boolean
  pairAddress: Address | null
  token0: Address | null
  token1: Address | null
}

/**
 * Check if a token has graduated to external Uniswap V2 pair.
 * Reads uniswapV2Pair() from the token contract and validates it.
 */
export async function checkGraduation(
  tokenAddress: Address,
): Promise<GraduationResult> {
  const client = getClient()

  try {
    const pairAddress = (await client.readContract({
      address: tokenAddress,
      abi: TOKEN_ABI,
      functionName: 'uniswapV2Pair',
    })) as Address

    if (
      !pairAddress ||
      pairAddress === '0x0000000000000000000000000000000000000000'
    ) {
      return { graduated: false, pairAddress: null, token0: null, token1: null }
    }

    // Verify it's a real contract
    const hasCode = await isContract(pairAddress)
    if (!hasCode) {
      return { graduated: false, pairAddress: null, token0: null, token1: null }
    }

    // Read token0, token1, and reserves to validate it's a real graduated pair
    const [token0, token1, reserves] = await Promise.all([
      client.readContract({
        address: pairAddress,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: 'token0',
      }) as Promise<Address>,
      client.readContract({
        address: pairAddress,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: 'token1',
      }) as Promise<Address>,
      client.readContract({
        address: pairAddress,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: 'getReserves',
      }) as Promise<[bigint, bigint, number]>,
    ])

    const [reserve0, reserve1] = reserves

    console.log(
      `[Graduation] Pair ${pairAddress}: token0=${token0}, token1=${token1}, reserves=[${reserve0}, ${reserve1}]`,
    )

    // A pair with zero reserves means the token has NOT graduated yet
    // (pair contract is pre-created but liquidity not yet added)
    if (reserve0 === 0n && reserve1 === 0n) {
      console.log(`[Graduation] Pair exists but has zero reserves - NOT graduated yet`)
      return {
        graduated: false,
        pairAddress: getAddress(pairAddress),
        token0: getAddress(token0),
        token1: getAddress(token1),
      }
    }

    return {
      graduated: true,
      pairAddress: getAddress(pairAddress),
      token0: getAddress(token0),
      token1: getAddress(token1),
    }
  } catch (error) {
    // uniswapV2Pair() may not exist or may revert
    return { graduated: false, pairAddress: null, token0: null, token1: null }
  }
}

/**
 * Get current reserves from a Uniswap V2 pair.
 */
export async function getReserves(
  pairAddress: Address,
): Promise<{ reserve0: bigint; reserve1: bigint } | null> {
  const client = getClient()

  try {
    const [reserve0, reserve1] = (await client.readContract({
      address: pairAddress,
      abi: UNISWAP_V2_PAIR_ABI,
      functionName: 'getReserves',
    })) as [bigint, bigint, number]

    return { reserve0, reserve1 }
  } catch {
    return null
  }
}

