import { parseAbi, keccak256, toBytes } from 'viem'

// ---- Base Chain ----
export const BASE_CHAIN_ID = 8453

// ---- VIRTUAL Token ----
export const VIRTUAL_ADDRESS =
  '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b' as const

// ---- ERC-20 Transfer Event ----
export const TRANSFER_EVENT_SIGNATURE = 'Transfer(address,address,uint256)'
export const TRANSFER_TOPIC = keccak256(toBytes(TRANSFER_EVENT_SIGNATURE))

// ---- Minimal Token ABI (for reading contract state) ----
export const TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  // Virtuals-specific
  'function pairToken() view returns (address)',
  'function projectTaxRecipient() view returns (address)',
  'function uniswapV2Pair() view returns (address)',
  'function botProtectionDurationInSeconds() view returns (uint256)',
  'function totalBuyTaxBasisPoints() view returns (uint256)',
  'function totalSellTaxBasisPoints() view returns (uint256)',
])

// ---- Uniswap V2 Pair ABI ----
export const UNISWAP_V2_PAIR_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
])

// ---- ERC-20 Transfer ABI (for log parsing) ----
export const ERC20_TRANSFER_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

// ---- Uniswap V2 Swap Event Topic ----
export const SWAP_EVENT_SIGNATURE =
  'Swap(address,uint256,uint256,uint256,uint256,address)'
export const SWAP_TOPIC = keccak256(toBytes(SWAP_EVENT_SIGNATURE))

