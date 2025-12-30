import { BaseStrategy } from './base-strategy.js';
import type { Market, Opportunity, Position, ArbitrageOpportunity } from '../types/index.js';
import { config } from '../config/index.js';

export class ArbitrageStrategy extends BaseStrategy {
  name = 'arbitrage' as const;

  // Minimum profit percentage to consider (after fees)
  private readonly MIN_PROFIT_PCT = 0.02; // 2%

  // Maximum profit percentage (too good = suspicious)
  private readonly MAX_PROFIT_PCT = 0.15; // 15%

  scan(markets: Market[]): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];

    for (const market of markets) {
      const opportunity = this.checkMarketForArbitrage(market);
      if (opportunity) {
        opportunities.push(opportunity);
      }
    }

    // Sort by profit percentage (highest first)
    return opportunities.sort((a, b) => b.profitPercent - a.profitPercent);
  }

  private checkMarketForArbitrage(market: Market): ArbitrageOpportunity | null {
    // Need at least 2 outcomes
    if (market.outcomes.length < 2) {
      return null;
    }

    // Check liquidity
    if (market.liquidity < config.trading.minMarketLiquidity) {
      return null;
    }

    // All outcomes must have prices
    if (market.outcomes.some((o) => o.price <= 0 || o.price >= 1)) {
      return null;
    }

    // Calculate total cost of buying all outcomes
    const totalCost = market.outcomes.reduce((sum, o) => sum + o.price, 0);

    // For arbitrage: total cost must be < $1 (guaranteed $1 payout)
    if (totalCost >= 1) {
      return null;
    }

    const guaranteedProfit = 1 - totalCost;
    const profitPercent = guaranteedProfit / totalCost;

    // Check profit thresholds
    if (profitPercent < this.MIN_PROFIT_PCT) {
      return null; // Not profitable enough after fees
    }

    if (profitPercent > this.MAX_PROFIT_PCT) {
      // Too good to be true - might be stale data or market about to close
      console.log(
        `[ARB] Suspicious opportunity: ${market.question.slice(0, 40)}... profit ${(profitPercent * 100).toFixed(2)}% - skipping`
      );
      return null;
    }

    // Build opportunity
    return {
      market,
      strategy: 'arbitrage',
      side: 'YES', // For arbitrage, we buy all sides
      outcomeIndex: 0,
      entryPrice: totalCost,
      estimatedProb: 1, // Guaranteed outcome
      edge: guaranteedProfit,
      confidence: 'arbitrage',
      reason: `Buy all ${market.outcomes.length} outcomes for $${totalCost.toFixed(3)}, guaranteed $1 payout`,
      outcomes: market.outcomes.map((o) => ({
        name: o.name,
        price: o.price,
        tokenId: o.tokenId,
      })),
      totalCost,
      guaranteedProfit,
      profitPercent,
    };
  }

  // Arbitrage positions should be held until market resolution
  // No early exit needed since profit is locked in
  shouldExit(_position: Position, _currentPrice: number): boolean {
    // For arbitrage, we hold until market resolves
    // The position will be closed when the market settles
    return false;
  }

  // Check if a market with multiple outcomes has arbitrage opportunity
  static findMultiOutcomeArbitrage(market: Market): {
    exists: boolean;
    totalCost: number;
    profit: number;
    profitPct: number;
  } {
    if (market.outcomes.length < 2) {
      return { exists: false, totalCost: 0, profit: 0, profitPct: 0 };
    }

    const totalCost = market.outcomes.reduce((sum, o) => sum + o.price, 0);
    const profit = 1 - totalCost;
    const profitPct = totalCost > 0 ? profit / totalCost : 0;

    return {
      exists: totalCost < 1 && profitPct > 0.02,
      totalCost,
      profit,
      profitPct,
    };
  }

  // For binary markets (YES/NO), check if YES + NO < $1
  static findBinaryArbitrage(market: Market): {
    exists: boolean;
    yesPrice: number;
    noPrice: number;
    totalCost: number;
    profit: number;
  } {
    if (market.outcomes.length !== 2) {
      return { exists: false, yesPrice: 0, noPrice: 0, totalCost: 0, profit: 0 };
    }

    const yesOutcome = market.outcomes.find(
      (o) => o.name.toLowerCase() === 'yes' || o.name.toLowerCase().includes('yes')
    );
    const noOutcome = market.outcomes.find(
      (o) => o.name.toLowerCase() === 'no' || o.name.toLowerCase().includes('no')
    );

    if (!yesOutcome || !noOutcome) {
      // Not a yes/no market, treat as multi-outcome
      return { exists: false, yesPrice: 0, noPrice: 0, totalCost: 0, profit: 0 };
    }

    const totalCost = yesOutcome.price + noOutcome.price;
    const profit = 1 - totalCost;

    return {
      exists: totalCost < 1 && profit / totalCost > 0.02,
      yesPrice: yesOutcome.price,
      noPrice: noOutcome.price,
      totalCost,
      profit,
    };
  }
}

export const arbitrageStrategy = new ArbitrageStrategy();
