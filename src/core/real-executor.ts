import type {
  Opportunity,
  Position,
  Trade,
  Portfolio,
  MarketCategory,
} from '../types/index.js';
import { store } from '../data/sqlite-store.js';
import { config } from '../config/index.js';
import { clobClient } from '../clients/clob-client.js';
import { logger } from '../utils/logger.js';

const REAL_FEE_RATE = 0.002; // 0.2% Polymarket fee

export class RealExecutor {
  private initialized = false;
  private realBalance: number = 0;
  private peakValue: number;
  private startingBalance: number;

  constructor() {
    this.peakValue = config.startingBalance;
    this.startingBalance = config.startingBalance;
  }

  // Initialize with CLOB credentials
  async initialize(): Promise<boolean> {
    if (!config.api.address || !config.api.privateKey) {
      throw new Error('POLYMARKET_ID and POLYMARKET_KEY must be set in .env for real trading');
    }

    try {
      await clobClient.initialize(config.api.privateKey, config.api.address);

      // Get actual balance from Polymarket
      this.realBalance = await clobClient.getBalance();
      this.startingBalance = this.realBalance;
      this.peakValue = this.realBalance;
      this.initialized = true;

      logger.log('INFO', 'Real executor initialized', {
        address: config.api.address,
        balance: this.realBalance,
      });

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.log('ERROR', 'Failed to initialize real executor', { error: message });
      throw error;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async getPortfolio(): Promise<Portfolio> {
    if (!this.initialized) {
      throw new Error('Real executor not initialized');
    }

    // Get real balance and positions from CLOB
    this.realBalance = await clobClient.getBalance();
    const clobPositions = await clobClient.getPositions();

    // Get local position records for additional info
    const openPositions = store.getOpenPositions();
    const allocations = store.getAllocations();

    // Calculate positions value
    let positionsValue = 0;
    for (const cp of clobPositions) {
      try {
        const price = await clobClient.getMidPrice(cp.tokenId);
        positionsValue += cp.size * price;
      } catch {
        // Use avg price if mid price unavailable
        positionsValue += cp.size * cp.avgPrice;
      }
    }

    const totalValue = this.realBalance + positionsValue;
    const totalPnl = totalValue - this.startingBalance;
    const totalPnlPercent = this.startingBalance > 0 ? (totalPnl / this.startingBalance) * 100 : 0;

    if (totalValue > this.peakValue) {
      this.peakValue = totalValue;
    }

    const drawdown = this.peakValue - totalValue;
    const drawdownPercent = this.peakValue > 0 ? (drawdown / this.peakValue) * 100 : 0;

    return {
      balance: this.realBalance,
      totalValue,
      startingBalance: this.startingBalance,
      totalPnl,
      totalPnlPercent,
      openPositions, // Local records for UI
      allocations,
      drawdown,
      drawdownPercent,
      peakValue: this.peakValue,
    };
  }

  canTrade(): { allowed: boolean; reason?: string } {
    if (!this.initialized) {
      return { allowed: false, reason: 'Real executor not initialized' };
    }

    // Additional safety checks for real trading
    if (this.realBalance < config.sizing.minPositionUsd * 2) {
      return {
        allowed: false,
        reason: `Insufficient balance: $${this.realBalance.toFixed(2)}`,
      };
    }

    return { allowed: true };
  }

  calculatePositionSize(opportunity: Opportunity): number {
    // More conservative sizing for real trading
    const edge = opportunity.edge;
    if (edge <= 0) return 0;

    const fullKelly = edge / (1 - opportunity.entryPrice);

    // Use half the Kelly fractions for real money (more conservative)
    const kellyFractions = {
      low: 0.075,      // Half of paper trading
      standard: 0.125,
      high: 0.20,
      arbitrage: 0.25,
    };

    const kellySize = fullKelly * kellyFractions[opportunity.confidence];

    // Stricter position limits for real trading
    const maxPct = Math.min(kellySize, config.risk.maxPositionPct * 0.5);
    let size = maxPct * this.realBalance;

    // Apply absolute limits (more conservative)
    size = Math.max(
      config.sizing.minPositionUsd,
      Math.min(size, config.sizing.maxPositionUsd * 0.5)
    );

    // Leave larger buffer for real trading
    size = Math.min(size, this.realBalance * 0.8);

    return Math.max(0, size);
  }

  async executeBuy(opportunity: Opportunity): Promise<Position | null> {
    if (!this.initialized) {
      logger.log('ERROR', 'Cannot execute buy: Real executor not initialized');
      return null;
    }

    const canTrade = this.canTrade();
    if (!canTrade.allowed) {
      logger.log('WARN', 'Cannot execute buy', { reason: canTrade.reason });
      return null;
    }

    const size = this.calculatePositionSize(opportunity);
    if (size < config.sizing.minPositionUsd) {
      return null;
    }

    const tokenId = opportunity.market.outcomes[opportunity.outcomeIndex]?.tokenId;
    if (!tokenId) {
      logger.log('ERROR', 'No tokenId for opportunity', { market: opportunity.market.question });
      return null;
    }

    try {
      // Calculate shares to buy
      const shares = size / opportunity.entryPrice;

      logger.log('INFO', 'Executing real BUY order', {
        market: opportunity.market.question,
        side: opportunity.side,
        price: opportunity.entryPrice,
        size,
        shares,
        tokenId,
      });

      // Place market order on CLOB
      const orderResult = await clobClient.placeMarketOrder(tokenId, 'BUY', shares);

      if (orderResult.status !== 'FILLED' && orderResult.filledAmount === 0) {
        logger.log('WARN', 'Order not filled', { orderId: orderResult.orderId, status: orderResult.status });
        return null;
      }

      const filledShares = orderResult.filledAmount || shares;
      const avgPrice = orderResult.avgFillPrice || opportunity.entryPrice;
      const actualSize = filledShares * avgPrice;
      const fees = actualSize * REAL_FEE_RATE;

      // Create local position record
      // cost = total spent, size = net after fees
      const position = store.createPosition({
        marketId: opportunity.market.id,
        marketQuestion: opportunity.market.question,
        category: opportunity.market.category,
        strategy: opportunity.strategy,
        side: opportunity.side,
        outcomeId: tokenId,
        entryPrice: avgPrice,
        currentPrice: avgPrice,
        size: actualSize - fees,
        cost: actualSize,  // Total cost including fees
        shares: filledShares,
        entryTime: new Date(),
      });

      // Record trade
      store.recordTrade({
        positionId: position.id,
        marketId: opportunity.market.id,
        marketQuestion: opportunity.market.question,
        category: opportunity.market.category,
        strategy: opportunity.strategy,
        side: opportunity.side,
        action: 'BUY',
        price: avgPrice,
        size: actualSize - fees,
        shares: filledShares,
        fees,
        timestamp: new Date(),
      });

      // Update balance
      this.realBalance = await clobClient.getBalance();

      logger.log('INFO', 'Real BUY executed', {
        orderId: orderResult.orderId,
        filledShares,
        avgPrice,
        actualSize,
      });

      return position;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.log('ERROR', 'Failed to execute real BUY', {
        error: message,
        market: opportunity.market.question,
      });
      return null;
    }
  }

  async executeSell(position: Position, currentPrice: number): Promise<Trade | null> {
    if (!this.initialized) {
      logger.log('ERROR', 'Cannot execute sell: Real executor not initialized');
      return null;
    }

    try {
      logger.log('INFO', 'Executing real SELL order', {
        market: position.marketQuestion,
        side: position.side,
        price: currentPrice,
        shares: position.shares,
        tokenId: position.outcomeId,
      });

      // Place market sell order on CLOB
      const orderResult = await clobClient.placeMarketOrder(position.outcomeId, 'SELL', position.shares);

      if (orderResult.status !== 'FILLED' && orderResult.filledAmount === 0) {
        logger.log('WARN', 'Sell order not filled', { orderId: orderResult.orderId, status: orderResult.status });
        return null;
      }

      const filledShares = orderResult.filledAmount || position.shares;
      const avgPrice = orderResult.avgFillPrice || currentPrice;
      const grossProceeds = filledShares * avgPrice;
      const fees = grossProceeds * REAL_FEE_RATE;
      const netProceeds = grossProceeds - fees;
      const pnl = netProceeds - position.size;

      // Close local position
      store.closePosition(position.id, avgPrice);

      // Record trade
      const trade = store.recordTrade({
        positionId: position.id,
        marketId: position.marketId,
        marketQuestion: position.marketQuestion,
        category: position.category,
        strategy: position.strategy,
        side: position.side,
        action: 'SELL',
        price: avgPrice,
        size: netProceeds,
        shares: filledShares,
        fees,
        timestamp: new Date(),
        pnl,
      });

      // Update balance
      this.realBalance = await clobClient.getBalance();

      logger.log('INFO', 'Real SELL executed', {
        orderId: orderResult.orderId,
        filledShares,
        avgPrice,
        netProceeds,
        pnl,
      });

      return trade;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.log('ERROR', 'Failed to execute real SELL', {
        error: message,
        market: position.marketQuestion,
      });
      return null;
    }
  }

  // Arbitrage on real markets (buy all outcomes)
  async executeArbitrageBuy(
    market: { id: string; question: string; category: MarketCategory },
    outcomes: { name: string; price: number; tokenId: string }[],
    totalCost: number,
    guaranteedProfit: number
  ): Promise<Position[]> {
    if (!this.initialized) {
      logger.log('ERROR', 'Cannot execute arbitrage: Real executor not initialized');
      return [];
    }

    const canTrade = this.canTrade();
    if (!canTrade.allowed) {
      return [];
    }

    // Very conservative for real arbitrage
    const maxSize = Math.min(
      this.realBalance * 0.3,  // Max 30% of balance for arb
      config.sizing.maxPositionUsd * 0.25
    );

    const sets = Math.floor(maxSize / totalCost);
    if (sets < 1) {
      return [];
    }

    const totalInvestment = sets * totalCost;
    const positions: Position[] = [];

    logger.log('INFO', 'Executing real ARBITRAGE', {
      market: market.question,
      totalCost,
      profit: guaranteedProfit,
      sets,
      totalInvestment,
    });

    try {
      // Buy each outcome
      for (const outcome of outcomes) {
        const outcomeSize = (totalInvestment * outcome.price) / totalCost;
        const shares = outcomeSize / outcome.price;

        const orderResult = await clobClient.placeMarketOrder(outcome.tokenId, 'BUY', shares);

        if (orderResult.filledAmount > 0) {
          const filledShares = orderResult.filledAmount;
          const avgPrice = orderResult.avgFillPrice || outcome.price;
          const actualSize = filledShares * avgPrice;
          const fees = actualSize * REAL_FEE_RATE;

          const position = store.createPosition({
            marketId: market.id,
            marketQuestion: market.question,
            category: market.category,
            strategy: 'arbitrage',
            side: outcome.name.toUpperCase() === 'YES' ? 'YES' : 'NO',
            outcomeId: outcome.tokenId,
            entryPrice: avgPrice,
            currentPrice: avgPrice,
            size: actualSize - fees,
            cost: actualSize,  // Total cost including fees
            shares: filledShares,
            entryTime: new Date(),
          });

          store.recordTrade({
            positionId: position.id,
            marketId: market.id,
            marketQuestion: market.question,
            category: market.category,
            strategy: 'arbitrage',
            side: position.side,
            action: 'BUY',
            price: avgPrice,
            size: actualSize - fees,
            shares: filledShares,
            fees,
            timestamp: new Date(),
          });

          positions.push(position);
        }
      }

      // Update balance
      this.realBalance = await clobClient.getBalance();

      logger.log('INFO', 'Real ARBITRAGE executed', {
        market: market.question,
        positions: positions.length,
      });

      return positions;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.log('ERROR', 'Failed to execute real ARBITRAGE', {
        error: message,
        market: market.question,
      });
      return positions; // Return any positions we managed to create
    }
  }

  // Get current real balance
  async refreshBalance(): Promise<number> {
    if (!this.initialized) {
      throw new Error('Real executor not initialized');
    }
    this.realBalance = await clobClient.getBalance();
    return this.realBalance;
  }
}

export const realExecutor = new RealExecutor();
