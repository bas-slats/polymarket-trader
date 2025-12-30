import { BaseStrategy } from './base-strategy.js';
import type { Market, Opportunity, Position, ConfidenceLevel } from '../types/index.js';
import { config } from '../config/index.js';

// Historical price data for mean reversion analysis
interface PriceHistory {
  assetId: string;
  prices: { price: number; timestamp: number }[];
  lastUpdate: number;
}

export class ValueBettingStrategy extends BaseStrategy {
  name = 'value' as const;

  // Minimum edge to consider
  private readonly MIN_EDGE = config.trading.minEdgePct;

  // Price history for analysis
  private priceHistory: Map<string, PriceHistory> = new Map();

  scan(markets: Market[]): Opportunity[] {
    const opportunities: Opportunity[] = [];

    for (const market of markets) {
      // Skip markets with insufficient liquidity
      if (market.liquidity < config.trading.minMarketLiquidity) {
        continue;
      }

      // Skip markets too close to resolution (< 1 hour)
      const hoursToEnd = (market.endDate.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursToEnd < 1) {
        continue;
      }

      // Record price history
      this.recordPrices(market);

      // Analyze each outcome and find the BEST one per market
      let bestOpportunity: Opportunity | null = null;

      for (let i = 0; i < market.outcomes.length; i++) {
        const outcome = market.outcomes[i];
        const opportunity = this.analyzeOutcome(market, outcome, i);
        if (opportunity) {
          // Only keep the opportunity with higher edge per market
          if (!bestOpportunity || opportunity.edge > bestOpportunity.edge) {
            bestOpportunity = opportunity;
          }
        }
      }

      // Only add the best opportunity for this market
      if (bestOpportunity) {
        opportunities.push(bestOpportunity);
      }
    }

    // Sort by edge (highest first)
    return opportunities.sort((a, b) => b.edge - a.edge);
  }

  private recordPrices(market: Market): void {
    const now = Date.now();
    for (const outcome of market.outcomes) {
      if (!outcome.tokenId) continue;

      let history = this.priceHistory.get(outcome.tokenId);
      if (!history) {
        history = {
          assetId: outcome.tokenId,
          prices: [],
          lastUpdate: 0,
        };
        this.priceHistory.set(outcome.tokenId, history);
      }

      // Only record if price changed and enough time passed (1 min)
      const lastPrice = history.prices[history.prices.length - 1];
      if (!lastPrice || (now - lastPrice.timestamp > 60000 && lastPrice.price !== outcome.price)) {
        history.prices.push({ price: outcome.price, timestamp: now });
        history.lastUpdate = now;

        // Keep last 100 price points
        if (history.prices.length > 100) {
          history.prices = history.prices.slice(-100);
        }
      }
    }
  }

  private analyzeOutcome(
    market: Market,
    outcome: { id: string; name: string; price: number; tokenId: string },
    outcomeIndex: number
  ): Opportunity | null {
    const price = outcome.price;

    // Skip extreme prices (too close to 0 or 1)
    if (price < 0.05 || price > 0.95) {
      return null;
    }

    // Estimate "true" probability using multiple signals
    const estimation = this.estimateProbability(market, outcome, outcomeIndex);

    // Calculate edge
    const edge = estimation.estimatedProb - price;

    // Need minimum edge
    if (edge < this.MIN_EDGE) {
      return null;
    }

    // Determine confidence
    const confidence = this.assessConfidence(market, edge, estimation);

    const side = outcome.name.toLowerCase().includes('yes') ? 'YES' : 'NO';

    return {
      market,
      strategy: 'value',
      side,
      outcomeIndex,
      entryPrice: price,
      estimatedProb: estimation.estimatedProb,
      edge,
      confidence,
      reason: estimation.reason,
    };
  }

  private estimateProbability(
    market: Market,
    outcome: { id: string; name: string; price: number; tokenId: string },
    outcomeIndex: number
  ): { estimatedProb: number; reason: string; signals: string[] } {
    const price = outcome.price;
    const signals: string[] = [];
    let adjustments: number[] = [];

    // === Signal 1: Price Extremity Bias ===
    // Markets at extreme prices (< 0.15 or > 0.85) tend to be overconfident
    if (price < 0.15) {
      // Low probability events often underpriced
      const extremityBonus = (0.15 - price) * 0.3; // Up to 4.5% boost
      adjustments.push(extremityBonus);
      signals.push(`Low prob boost +${(extremityBonus * 100).toFixed(1)}%`);
    } else if (price > 0.85) {
      // High probability events often overpriced - but we're looking at this outcome
      // Actually this means the NO side might be underpriced
      const extremityPenalty = (price - 0.85) * -0.2; // Up to 3% penalty
      adjustments.push(extremityPenalty);
      signals.push(`High prob penalty ${(extremityPenalty * 100).toFixed(1)}%`);
    }

    // === Signal 2: Liquidity-Volume Ratio ===
    // High volume relative to liquidity suggests informed trading
    const volumeToLiquidity = market.volume / Math.max(market.liquidity, 1);
    if (volumeToLiquidity > 10) {
      // High activity market - prices likely more efficient
      // Reduce our confidence in finding edge
      adjustments.push(-0.01);
      signals.push('High activity market');
    } else if (volumeToLiquidity < 2) {
      // Low activity - more likely to find mispricing
      adjustments.push(0.02);
      signals.push('Low activity opportunity');
    }

    // === Signal 3: Time to Resolution ===
    const hoursToEnd = (market.endDate.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursToEnd < 24) {
      // Close to resolution - prices should be more accurate
      adjustments.push(-0.01);
      signals.push('Near resolution');
    } else if (hoursToEnd > 168) {
      // Far from resolution (> 1 week) - more uncertainty
      adjustments.push(0.015);
      signals.push('Long-dated market');
    }

    // === Signal 4: Binary Market Sum ===
    // In binary markets, if YES + NO < 1, there's guaranteed profit potential
    if (market.outcomes.length === 2) {
      const totalPrice = market.outcomes.reduce((sum, o) => sum + o.price, 0);
      if (totalPrice < 0.98) {
        const spreadBonus = (1 - totalPrice) / 2;
        adjustments.push(spreadBonus);
        signals.push(`Spread opportunity +${(spreadBonus * 100).toFixed(1)}%`);
      }
    }

    // === Signal 5: Mean Reversion ===
    const history = this.priceHistory.get(outcome.tokenId);
    if (history && history.prices.length >= 5) {
      const recentPrices = history.prices.slice(-10);
      const avgPrice = recentPrices.reduce((sum, p) => sum + p.price, 0) / recentPrices.length;
      const priceDeviation = price - avgPrice;

      // If current price is significantly below recent average, might be oversold
      if (priceDeviation < -0.05) {
        const reversionBonus = Math.min(0.05, Math.abs(priceDeviation) * 0.5);
        adjustments.push(reversionBonus);
        signals.push(`Mean reversion +${(reversionBonus * 100).toFixed(1)}%`);
      }
    }

    // === Signal 6: Category-Specific Adjustments ===
    switch (market.category) {
      case 'politics':
        // Political markets often have biased retail traders
        adjustments.push(0.01);
        signals.push('Political market bias');
        break;
      case 'crypto':
        // Crypto markets are volatile - wider margins needed
        adjustments.push(-0.01);
        signals.push('Crypto volatility discount');
        break;
      case 'sports':
        // Sports markets are often well-priced
        adjustments.push(-0.005);
        signals.push('Sports efficiency');
        break;
    }

    // Calculate final estimated probability
    const totalAdjustment = adjustments.reduce((sum, a) => sum + a, 0);
    const estimatedProb = Math.max(0.01, Math.min(0.99, price + totalAdjustment));

    // Build reason string
    const topSignals = signals.slice(0, 3).join(', ');
    const reason = `Est. ${(estimatedProb * 100).toFixed(1)}% vs ${(price * 100).toFixed(1)}% market | ${topSignals}`;

    return {
      estimatedProb,
      reason,
      signals,
    };
  }

  private assessConfidence(
    market: Market,
    edge: number,
    estimation: { estimatedProb: number; reason: string; signals: string[] }
  ): ConfidenceLevel {
    let score = 0;

    // Edge size
    if (edge >= 0.08) score += 3;
    else if (edge >= 0.05) score += 2;
    else if (edge >= 0.03) score += 1;

    // Liquidity
    if (market.liquidity >= 100000) score += 2;
    else if (market.liquidity >= 50000) score += 1;

    // Number of confirming signals
    if (estimation.signals.length >= 4) score += 2;
    else if (estimation.signals.length >= 2) score += 1;

    // Volume indicates interest
    if (market.volume >= 500000) score += 1;

    // Category bonus
    if (market.category === 'politics') score += 1;

    if (score >= 6) return 'high';
    if (score >= 3) return 'standard';
    return 'low';
  }

  shouldExit(position: Position, currentPrice: number): boolean {
    const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

    // Take profit at +15%
    if (pnlPercent >= 15) {
      return true;
    }

    // Stop loss at -20%
    if (pnlPercent <= -20) {
      return true;
    }

    // Exit if price moved to extreme (almost resolved)
    if (currentPrice >= 0.95 || currentPrice <= 0.05) {
      return true;
    }

    // Trailing stop: if we were up 10%+ and now only up 3%, exit
    const peakPnl = Math.max(
      ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100,
      pnlPercent
    );
    if (peakPnl >= 10 && pnlPercent < 3) {
      return true;
    }

    return false;
  }

  // Get analysis for a specific market (for debugging)
  analyzeMarket(market: Market): {
    outcome: string;
    price: number;
    estimatedProb: number;
    edge: number;
    signals: string[];
  }[] {
    const results: {
      outcome: string;
      price: number;
      estimatedProb: number;
      edge: number;
      signals: string[];
    }[] = [];

    for (let i = 0; i < market.outcomes.length; i++) {
      const outcome = market.outcomes[i];
      this.recordPrices(market);
      const estimation = this.estimateProbability(market, outcome, i);
      const edge = estimation.estimatedProb - outcome.price;

      results.push({
        outcome: outcome.name,
        price: outcome.price,
        estimatedProb: estimation.estimatedProb,
        edge,
        signals: estimation.signals,
      });
    }

    return results;
  }
}

export const valueBettingStrategy = new ValueBettingStrategy();
