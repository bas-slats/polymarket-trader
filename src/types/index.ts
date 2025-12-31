// Market types
export interface Market {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  category: MarketCategory;
  outcomes: Outcome[];
  volume: number;
  liquidity: number;
  endDate: Date;
  active: boolean;
  closed: boolean;
}

export interface Outcome {
  id: string;
  name: string;
  price: number;
  tokenId: string;
}

export type MarketCategory =
  | 'politics'
  | 'sports'
  | 'crypto'
  | 'entertainment'
  | 'science'
  | 'business'
  | 'other';

// Trading types
export interface Position {
  id: string;
  marketId: string;
  marketQuestion: string;
  category: MarketCategory;
  strategy: StrategyName;
  side: 'YES' | 'NO';
  outcomeId: string;
  entryPrice: number;
  currentPrice: number;
  size: number;          // USD value invested (after fees)
  cost: number;          // Total cost deducted from balance (including fees)
  shares: number;        // Number of shares
  entryTime: Date;
  pnl: number;
  pnlPercent: number;
  status: 'open' | 'closed';
}

export interface Trade {
  id: string;
  positionId: string;
  marketId: string;
  marketQuestion: string;
  category: MarketCategory;
  strategy: StrategyName;
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  price: number;
  size: number;
  shares: number;
  fees: number;
  timestamp: Date;
  pnl?: number;          // Only for closing trades
}

export interface Opportunity {
  market: Market;
  strategy: StrategyName;
  side: 'YES' | 'NO';
  outcomeIndex: number;
  entryPrice: number;
  estimatedProb: number;
  edge: number;          // estimatedProb - entryPrice
  confidence: ConfidenceLevel;
  reason: string;
}

export type ConfidenceLevel = 'low' | 'standard' | 'high' | 'arbitrage';

// Strategy types
export type StrategyName =
  | 'arbitrage'
  | 'value'
  | 'whale'
  | 'momentum'
  | 'mean_reversion';

export interface StrategyAllocation {
  strategy: StrategyName;
  currentWeight: number;
  minWeight: number;
  maxWeight: number;
  performanceScore: number;
}

export interface StrategyPerformance {
  strategy: StrategyName;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  sharpe: number;
  lastUpdated: Date;
}

// Portfolio types
export interface Portfolio {
  balance: number;           // Available cash
  totalValue: number;        // Balance + positions value
  startingBalance: number;
  totalPnl: number;
  totalPnlPercent: number;
  openPositions: Position[];
  allocations: StrategyAllocation[];
  drawdown: number;
  drawdownPercent: number;
  peakValue: number;
}

// Arbitrage specific
export interface ArbitrageOpportunity extends Opportunity {
  outcomes: {
    name: string;
    price: number;
    tokenId: string;
  }[];
  totalCost: number;        // Sum of all outcome prices
  guaranteedProfit: number; // 1 - totalCost
  profitPercent: number;
}

// API response types (from Polymarket Gamma API)
export interface GammaMarket {
  id: string;
  condition_id: string;
  slug: string;
  question: string;
  description: string;
  end_date_iso: string;
  game_start_time?: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  volume: string;
  liquidity: string;
  outcomes: string;        // JSON string of outcome names
  outcome_prices: string;  // JSON string of prices
  clobTokenIds?: string;   // JSON string of token IDs for WebSocket
  tokens: GammaToken[];
  tags?: { label: string }[];
}

export interface GammaToken {
  token_id: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

// Config types
export interface Config {
  paperMode: boolean;
  startingBalance: number;

  api: {
    gammaHost: string;
    clobHost: string;
    address?: string;
    privateKey?: string;
  };

  allocations: Record<StrategyName, number>;

  risk: {
    maxPositionPct: number;
    maxCategoryPct: number;
    minBufferPct: number;
    drawdownWarningPct: number;
    drawdownHaltPct: number;
  };

  sizing: {
    kellyFraction: number;
    minPositionUsd: number;
    maxPositionUsd: number;
  };

  trading: {
    scanIntervalMs: number;
    minMarketLiquidity: number;
    minEdgePct: number;
  };

  logLevel: string;
}
