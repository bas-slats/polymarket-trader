import type { Market, Opportunity, Position, StrategyName } from '../types/index.js';

export interface Strategy {
  name: StrategyName;

  // Scan markets for opportunities
  scan(markets: Market[]): Opportunity[];

  // Check if we should exit a position
  shouldExit(position: Position, currentPrice: number): boolean;
}

export abstract class BaseStrategy implements Strategy {
  abstract name: StrategyName;

  abstract scan(markets: Market[]): Opportunity[];

  // Default exit logic: exit if price moved significantly against us
  // or if we've hit profit target
  shouldExit(position: Position, currentPrice: number): boolean {
    const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

    // Take profit at +20%
    if (pnlPercent >= 20) {
      return true;
    }

    // Stop loss at -15%
    if (pnlPercent <= -15) {
      return true;
    }

    return false;
  }
}
