import { EventEmitter } from 'events';
import type { Market, Opportunity, Position } from '../types/index.js';
import type { PriceUpdate, TradeUpdate } from '../clients/websocket-client.js';
import { executor } from './executor.js';
import { store } from '../data/sqlite-store.js';
import { whaleTracker } from '../strategies/whale-tracking.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

// Thresholds for event-driven trading
const PRICE_DROP_THRESHOLD = 0.05; // 5% drop triggers mean-reversion
const PRICE_SPIKE_THRESHOLD = 0.05; // 5% spike on positions triggers exit check
const WHALE_INSTANT_THRESHOLD = 5000; // $5k+ whale trade triggers instant follow
const ARB_SPREAD_THRESHOLD = 0.98; // Sum < 0.98 triggers instant arb

// Cooldowns to prevent over-trading (ms)
const PRICE_TRADE_COOLDOWN = 60000; // 1 min between price-triggered trades per asset
const WHALE_TRADE_COOLDOWN = 30000; // 30s between whale-triggered trades per asset

interface PriceHistory {
  assetId: string;
  prices: { price: number; timestamp: number }[];
  lastTradeTime: number;
}

interface MarketPriceMap {
  marketId: string;
  outcomes: { assetId: string; price: number; name: string }[];
  lastArbCheck: number;
}

export class EventTrader extends EventEmitter {
  private priceHistory: Map<string, PriceHistory> = new Map();
  private marketPrices: Map<string, MarketPriceMap> = new Map();
  private assetToMarket: Map<string, { market: Market; outcomeIndex: number }> = new Map();
  private lastWhaleFollow: Map<string, number> = new Map();
  private enabled = true;

  // Stats
  private stats = {
    priceDropTrades: 0,
    whaleFollowTrades: 0,
    arbTrades: 0,
    instantExits: 0,
  };

  // Register markets for tracking
  registerMarkets(markets: Market[]): void {
    this.assetToMarket.clear();
    this.marketPrices.clear();

    for (const market of markets) {
      const priceMap: MarketPriceMap = {
        marketId: market.id,
        outcomes: [],
        lastArbCheck: 0,
      };

      for (let i = 0; i < market.outcomes.length; i++) {
        const outcome = market.outcomes[i];
        if (outcome.tokenId) {
          this.assetToMarket.set(outcome.tokenId, { market, outcomeIndex: i });
          priceMap.outcomes.push({
            assetId: outcome.tokenId,
            price: outcome.price,
            name: outcome.name,
          });
        }
      }

      this.marketPrices.set(market.id, priceMap);
    }
  }

  // Handle real-time price update
  async handlePriceUpdate(update: PriceUpdate): Promise<void> {
    if (!this.enabled) return;

    const { assetId, price, timestamp } = update;

    // Update price history
    let history = this.priceHistory.get(assetId);
    if (!history) {
      history = { assetId, prices: [], lastTradeTime: 0 };
      this.priceHistory.set(assetId, history);
    }

    const lastPrice = history.prices[history.prices.length - 1]?.price;
    history.prices.push({ price, timestamp });

    // Keep last 20 prices
    if (history.prices.length > 20) {
      history.prices = history.prices.slice(-20);
    }

    // Update market price map
    const marketInfo = this.assetToMarket.get(assetId);
    if (marketInfo) {
      const priceMap = this.marketPrices.get(marketInfo.market.id);
      if (priceMap) {
        const outcomePrice = priceMap.outcomes.find((o) => o.assetId === assetId);
        if (outcomePrice) {
          outcomePrice.price = price;
        }
      }
    }

    // Check for trading signals
    if (lastPrice && lastPrice > 0) {
      const priceChange = (price - lastPrice) / lastPrice;

      // 1. Check for sudden price drop (mean-reversion opportunity)
      if (priceChange <= -PRICE_DROP_THRESHOLD) {
        await this.handlePriceDrop(assetId, price, lastPrice, priceChange);
      }

      // 2. Check for price spike on open positions (potential exit)
      if (priceChange >= PRICE_SPIKE_THRESHOLD) {
        await this.checkInstantExit(assetId, price);
      }
    }

    // 3. Check for arbitrage spread
    if (marketInfo) {
      await this.checkArbSpread(marketInfo.market);
    }
  }

  // Handle real-time trade update
  async handleTradeUpdate(update: TradeUpdate): Promise<void> {
    if (!this.enabled) return;

    const { assetId, price, size, side, timestamp } = update;

    // Record for whale tracking
    if (size >= 1000) {
      whaleTracker.recordTrade({ assetId, price, size, side, timestamp });
    }

    // Instant whale follow for very large trades
    if (size >= WHALE_INSTANT_THRESHOLD && side === 'BUY') {
      await this.handleWhaleTrade(assetId, price, size);
    }
  }

  private async handlePriceDrop(
    assetId: string,
    currentPrice: number,
    previousPrice: number,
    priceChange: number
  ): Promise<void> {
    const history = this.priceHistory.get(assetId);
    const now = Date.now();

    // Check cooldown
    if (history && now - history.lastTradeTime < PRICE_TRADE_COOLDOWN) {
      return;
    }

    // Get market info
    const marketInfo = this.assetToMarket.get(assetId);
    if (!marketInfo) return;

    const { market, outcomeIndex } = marketInfo;
    const outcome = market.outcomes[outcomeIndex];

    // Skip if price is extreme
    if (currentPrice < 0.05 || currentPrice > 0.95) return;

    // Skip low liquidity
    if (market.liquidity < config.trading.minMarketLiquidity) return;

    // Calculate mean from recent prices
    const recentPrices = history?.prices.slice(-10) || [];
    if (recentPrices.length < 3) return;

    const meanPrice = recentPrices.reduce((sum, p) => sum + p.price, 0) / recentPrices.length;
    const deviation = currentPrice - meanPrice;

    // Only trade if price dropped significantly below mean
    if (deviation > -0.03) return;

    // Estimate edge based on mean reversion
    const estimatedProb = Math.min(0.9, meanPrice + 0.02); // Expect reversion toward mean
    const edge = estimatedProb - currentPrice;

    if (edge < 0.03) return;

    const side = outcome.name.toLowerCase().includes('yes') ? 'YES' : 'NO';

    const opportunity: Opportunity = {
      market,
      strategy: 'value',
      side,
      outcomeIndex,
      entryPrice: currentPrice,
      estimatedProb,
      edge,
      confidence: edge >= 0.08 ? 'high' : 'standard',
      reason: `RT Price drop ${(priceChange * 100).toFixed(1)}% | Mean reversion from ${meanPrice.toFixed(3)}`,
    };

    logger.logOpportunity('RT_PRICE_DROP', market.question, {
      previousPrice,
      currentPrice,
      change: priceChange,
      edge,
    });

    const position = await executor.executeBuy(opportunity);
    if (position) {
      if (history) history.lastTradeTime = now;
      this.stats.priceDropTrades++;

      logger.logTrade({
        timestamp: new Date().toISOString(),
        action: 'BUY',
        strategy: 'value',
        market: market.question,
        side,
        price: currentPrice,
        size: position.size,
        reason: `RT: Price drop ${(priceChange * 100).toFixed(1)}%`,
      });

      this.emit('trade', { type: 'price_drop', position });
    }
  }

  private async handleWhaleTrade(
    assetId: string,
    price: number,
    size: number
  ): Promise<void> {
    const now = Date.now();

    // Check cooldown
    const lastFollow = this.lastWhaleFollow.get(assetId) || 0;
    if (now - lastFollow < WHALE_TRADE_COOLDOWN) return;

    // Get market info
    const marketInfo = this.assetToMarket.get(assetId);
    if (!marketInfo) return;

    const { market, outcomeIndex } = marketInfo;
    const outcome = market.outcomes[outcomeIndex];

    // Skip extreme prices
    if (price < 0.05 || price > 0.95) return;

    // Skip low liquidity
    if (market.liquidity < config.trading.minMarketLiquidity) return;

    const side = outcome.name.toLowerCase().includes('yes') ? 'YES' : 'NO';

    // Whales have edge, follow them with modest position
    const estimatedProb = Math.min(0.95, price + 0.08);
    const edge = estimatedProb - price;

    const opportunity: Opportunity = {
      market,
      strategy: 'whale',
      side,
      outcomeIndex,
      entryPrice: price,
      estimatedProb,
      edge,
      confidence: size >= 10000 ? 'high' : 'standard',
      reason: `RT Whale BUY $${(size / 1000).toFixed(1)}k @ ${price.toFixed(3)}`,
    };

    logger.logOpportunity('RT_WHALE', market.question, {
      price,
      size,
      side: 'BUY',
    });

    const position = await executor.executeBuy(opportunity);
    if (position) {
      this.lastWhaleFollow.set(assetId, now);
      this.stats.whaleFollowTrades++;

      logger.logTrade({
        timestamp: new Date().toISOString(),
        action: 'BUY',
        strategy: 'whale',
        market: market.question,
        side,
        price,
        size: position.size,
        reason: `RT: Whale $${(size / 1000).toFixed(1)}k`,
      });

      this.emit('trade', { type: 'whale_follow', position });
    }
  }

  private async checkArbSpread(market: Market): Promise<void> {
    const priceMap = this.marketPrices.get(market.id);
    if (!priceMap) return;

    const now = Date.now();

    // Cooldown per market
    if (now - priceMap.lastArbCheck < 5000) return;
    priceMap.lastArbCheck = now;

    // Only binary markets for now
    if (priceMap.outcomes.length !== 2) return;

    const totalPrice = priceMap.outcomes.reduce((sum, o) => sum + o.price, 0);

    // Check for arb opportunity
    if (totalPrice < ARB_SPREAD_THRESHOLD && totalPrice > 0.8) {
      // Only consider arb if total is between 0.8 and 0.98 (realistic range)
      // Below 0.8 means prices aren't fully loaded yet
      const profit = 1 - totalPrice;
      const profitPercent = profit / totalPrice;

      // Need meaningful profit (at least 1%)
      if (profitPercent < 0.01) return;

      // Verify both outcomes have valid prices
      const validPrices = priceMap.outcomes.every(o => o.price > 0.02 && o.price < 0.98);
      if (!validPrices) return;

      // Arbitrage detected - logged via events

      logger.logOpportunity('RT_ARB', market.question, {
        totalPrice,
        profit,
        profitPercent,
      });

      // Execute arb (simplified - buy all outcomes)
      const outcomes = priceMap.outcomes.map((o) => ({
        name: o.name,
        price: o.price,
        tokenId: o.assetId,
      }));

      const positions = await executor.executeArbitrageBuy(
        { id: market.id, question: market.question, category: market.category },
        outcomes,
        totalPrice,
        profit
      );

      if (positions.length > 0) {
        this.stats.arbTrades++;

        logger.logTrade({
          timestamp: new Date().toISOString(),
          action: 'BUY',
          strategy: 'arbitrage',
          market: market.question,
          side: 'ALL',
          price: totalPrice,
          size: positions.reduce((sum, p) => sum + p.size, 0),
          reason: `RT: Spread ${(profitPercent * 100).toFixed(2)}%`,
        });

        this.emit('trade', { type: 'arb', positions });
      }
    }
  }

  private async checkInstantExit(assetId: string, currentPrice: number): Promise<void> {
    const positions = store.getOpenPositions();

    for (const position of positions) {
      if (position.outcomeId !== assetId) continue;

      const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

      let shouldExit = false;
      let exitReason = '';

      // Take profit on big spike (15% to account for spread + slippage + fees ~5%)
      if (pnlPercent >= 15) {
        shouldExit = true;
        exitReason = `RT: Take profit +${pnlPercent.toFixed(1)}%`;
      }

      // Stop loss on extreme prices (only if not already exiting)
      if (!shouldExit && (currentPrice >= 0.97 || currentPrice <= 0.03)) {
        shouldExit = true;
        exitReason = `RT: Extreme price ${currentPrice.toFixed(3)}`;
      }

      // Execute exit only once
      if (shouldExit) {
        const trade = await executor.executeSell(position, currentPrice);
        if (trade) {
          this.stats.instantExits++;

          logger.logTrade({
            timestamp: new Date().toISOString(),
            action: 'SELL',
            strategy: position.strategy,
            market: position.marketQuestion,
            side: position.side,
            price: currentPrice,
            size: trade.size,
            pnl: trade.pnl,
            reason: exitReason,
          });

          this.emit('exit', { type: 'instant_exit', trade });
        }
      }
    }
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  clearHistory(): void {
    this.priceHistory.clear();
    this.lastWhaleFollow.clear();
  }
}

export const eventTrader = new EventTrader();
