import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import type { Config, StrategyName } from '../types/index.js';

dotenvConfig();

const envSchema = z.object({
  PAPER_MODE: z.string().default('true'),
  STARTING_BALANCE: z.string().default('1000'),

  POLYMARKET_GAMMA_HOST: z.string().default('https://gamma-api.polymarket.com'),
  POLYMARKET_CLOB_HOST: z.string().default('https://clob.polymarket.com'),
  POLYMARKET_ID: z.string().optional(),
  POLYMARKET_KEY: z.string().optional(),

  ALLOCATION_ARBITRAGE: z.string().default('30'),
  ALLOCATION_VALUE: z.string().default('30'),
  ALLOCATION_WHALE: z.string().default('20'),
  ALLOCATION_MOMENTUM: z.string().default('15'),
  ALLOCATION_MEAN_REVERSION: z.string().default('5'),

  MAX_POSITION_PCT: z.string().default('10'),
  MAX_CATEGORY_PCT: z.string().default('30'),
  MIN_BUFFER_PCT: z.string().default('20'),
  DRAWDOWN_WARNING_PCT: z.string().default('15'),
  DRAWDOWN_HALT_PCT: z.string().default('25'),

  KELLY_FRACTION: z.string().default('0.25'),
  MIN_POSITION_USD: z.string().default('10'),
  MAX_POSITION_USD: z.string().default('5000'),

  SCAN_INTERVAL_MS: z.string().default('300000'),
  MIN_MARKET_LIQUIDITY: z.string().default('10000'),
  MIN_EDGE_PCT: z.string().default('2'),

  LOG_LEVEL: z.string().default('info'),
});

export function loadConfig(): Config {
  const env = envSchema.parse(process.env);

  const allocations: Record<StrategyName, number> = {
    arbitrage: parseFloat(env.ALLOCATION_ARBITRAGE) / 100,
    value: parseFloat(env.ALLOCATION_VALUE) / 100,
    whale: parseFloat(env.ALLOCATION_WHALE) / 100,
    momentum: parseFloat(env.ALLOCATION_MOMENTUM) / 100,
    mean_reversion: parseFloat(env.ALLOCATION_MEAN_REVERSION) / 100,
  };

  // Validate allocations sum to 100%
  const totalAllocation = Object.values(allocations).reduce((a, b) => a + b, 0);
  if (Math.abs(totalAllocation - 1) > 0.01) {
    throw new Error(`Strategy allocations must sum to 100%, got ${totalAllocation * 100}%`);
  }

  return {
    paperMode: env.PAPER_MODE === 'true',
    startingBalance: parseFloat(env.STARTING_BALANCE),

    api: {
      gammaHost: env.POLYMARKET_GAMMA_HOST,
      clobHost: env.POLYMARKET_CLOB_HOST,
      address: env.POLYMARKET_ID,
      privateKey: env.POLYMARKET_KEY,
    },

    allocations,

    risk: {
      maxPositionPct: parseFloat(env.MAX_POSITION_PCT) / 100,
      maxCategoryPct: parseFloat(env.MAX_CATEGORY_PCT) / 100,
      minBufferPct: parseFloat(env.MIN_BUFFER_PCT) / 100,
      drawdownWarningPct: parseFloat(env.DRAWDOWN_WARNING_PCT) / 100,
      drawdownHaltPct: parseFloat(env.DRAWDOWN_HALT_PCT) / 100,
    },

    sizing: {
      kellyFraction: parseFloat(env.KELLY_FRACTION),
      minPositionUsd: parseFloat(env.MIN_POSITION_USD),
      maxPositionUsd: parseFloat(env.MAX_POSITION_USD),
    },

    trading: {
      scanIntervalMs: parseInt(env.SCAN_INTERVAL_MS),
      minMarketLiquidity: parseFloat(env.MIN_MARKET_LIQUIDITY),
      minEdgePct: parseFloat(env.MIN_EDGE_PCT) / 100,
    },

    logLevel: env.LOG_LEVEL,
  };
}

export const config = loadConfig();
