import type {
  Opportunity,
  Position,
  Trade,
  Portfolio,
  StrategyAllocation,
  MarketCategory,
} from '../types/index.js';
import { store } from '../data/sqlite-store.js';
import { config } from '../config/index.js';

const SIMULATED_FEE_RATE = 0.0022; // 0.22% per trade (fee + slippage)

export class PaperExecutor {
  private balance: number;
  private peakValue: number;
  private startingBalance: number;

  constructor() {
    // Try to restore from last snapshot
    const snapshot = store.getLatestSnapshot();
    if (snapshot) {
      this.balance = snapshot.balance;
      this.peakValue = snapshot.peakValue;
    } else {
      this.balance = config.startingBalance;
      this.peakValue = config.startingBalance;
    }
    this.startingBalance = config.startingBalance;
  }

  getPortfolio(): Portfolio {
    const openPositions = store.getOpenPositions();
    const allocations = store.getAllocations();

    const positionsValue = openPositions.reduce(
      (sum, p) => sum + p.currentPrice * p.shares,
      0
    );
    const totalValue = this.balance + positionsValue;
    const totalPnl = totalValue - this.startingBalance;
    const totalPnlPercent = (totalPnl / this.startingBalance) * 100;

    // Update peak value
    if (totalValue > this.peakValue) {
      this.peakValue = totalValue;
    }

    const drawdown = this.peakValue - totalValue;
    const drawdownPercent = this.peakValue > 0 ? (drawdown / this.peakValue) * 100 : 0;

    return {
      balance: this.balance,
      totalValue,
      startingBalance: this.startingBalance,
      totalPnl,
      totalPnlPercent,
      openPositions,
      allocations,
      drawdown,
      drawdownPercent,
      peakValue: this.peakValue,
    };
  }

  canTrade(): { allowed: boolean; reason?: string } {
    const portfolio = this.getPortfolio();

    // Check drawdown halt
    if (portfolio.drawdownPercent >= config.risk.drawdownHaltPct * 100) {
      return {
        allowed: false,
        reason: `Drawdown halt: ${portfolio.drawdownPercent.toFixed(1)}% >= ${config.risk.drawdownHaltPct * 100}%`,
      };
    }

    // Check minimum buffer
    const bufferRequired = portfolio.totalValue * config.risk.minBufferPct;
    if (this.balance < bufferRequired) {
      return {
        allowed: false,
        reason: `Insufficient buffer: $${this.balance.toFixed(2)} < $${bufferRequired.toFixed(2)} required`,
      };
    }

    return { allowed: true };
  }

  calculatePositionSize(opportunity: Opportunity): number {
    const portfolio = this.getPortfolio();

    // Base size from Kelly criterion
    const edge = opportunity.edge;
    if (edge <= 0) return 0;

    const fullKelly = edge / (1 - opportunity.entryPrice);
    const kellyFractions = {
      low: 0.15,
      standard: 0.25,
      high: 0.40,
      arbitrage: 0.50,
    };
    const kellySize = fullKelly * kellyFractions[opportunity.confidence];

    // Apply portfolio percentage cap
    const maxPct = Math.min(kellySize, config.risk.maxPositionPct);
    let size = maxPct * portfolio.totalValue;

    // Apply strategy allocation weight
    const allocation = portfolio.allocations.find((a) => a.strategy === opportunity.strategy);
    if (allocation) {
      const strategyBudget = portfolio.totalValue * allocation.currentWeight;
      const currentStrategyValue = portfolio.openPositions
        .filter((p) => p.strategy === opportunity.strategy)
        .reduce((sum, p) => sum + p.size, 0);
      const remainingBudget = strategyBudget - currentStrategyValue;
      size = Math.min(size, remainingBudget);
    }

    // Apply category limit
    const categoryValue = portfolio.openPositions
      .filter((p) => p.category === opportunity.market.category)
      .reduce((sum, p) => sum + p.size, 0);
    const categoryLimit = portfolio.totalValue * config.risk.maxCategoryPct;
    const categoryRemaining = categoryLimit - categoryValue;
    size = Math.min(size, categoryRemaining);

    // Apply absolute limits
    size = Math.max(config.sizing.minPositionUsd, Math.min(size, config.sizing.maxPositionUsd));

    // Can't exceed available balance
    size = Math.min(size, this.balance * 0.95); // Leave some buffer

    // If drawdown warning, reduce size by 50%
    if (portfolio.drawdownPercent >= config.risk.drawdownWarningPct * 100) {
      size *= 0.5;
    }

    return Math.max(0, size);
  }

  async executeBuy(opportunity: Opportunity): Promise<Position | null> {
    const canTrade = this.canTrade();
    if (!canTrade.allowed) {
      return null;
    }

    const size = this.calculatePositionSize(opportunity);
    if (size < config.sizing.minPositionUsd) {
      return null;
    }

    const fees = size * SIMULATED_FEE_RATE;
    const netSize = size - fees;
    const shares = netSize / opportunity.entryPrice;

    // Deduct from balance
    this.balance -= size;

    // Create position
    const position = store.createPosition({
      marketId: opportunity.market.id,
      marketQuestion: opportunity.market.question,
      category: opportunity.market.category,
      strategy: opportunity.strategy,
      side: opportunity.side,
      outcomeId: opportunity.market.outcomes[opportunity.outcomeIndex]?.id || '',
      entryPrice: opportunity.entryPrice,
      currentPrice: opportunity.entryPrice,
      size: netSize,
      shares,
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
      price: opportunity.entryPrice,
      size: netSize,
      shares,
      fees,
      timestamp: new Date(),
    });

    // Save snapshot
    store.savePortfolioSnapshot(this.getPortfolio());

    return position;
  }

  async executeSell(position: Position, currentPrice: number): Promise<Trade | null> {
    const fees = position.shares * currentPrice * SIMULATED_FEE_RATE;
    const grossProceeds = position.shares * currentPrice;
    const netProceeds = grossProceeds - fees;
    const pnl = netProceeds - position.size;

    // Add to balance
    this.balance += netProceeds;

    // Close position
    store.closePosition(position.id, currentPrice);

    // Record trade
    const trade = store.recordTrade({
      positionId: position.id,
      marketId: position.marketId,
      marketQuestion: position.marketQuestion,
      category: position.category,
      strategy: position.strategy,
      side: position.side,
      action: 'SELL',
      price: currentPrice,
      size: netProceeds,
      shares: position.shares,
      fees,
      timestamp: new Date(),
      pnl,
    });

    // Save snapshot
    store.savePortfolioSnapshot(this.getPortfolio());

    return trade;
  }

  // For arbitrage: buy all outcomes
  async executeArbitrageBuy(
    market: { id: string; question: string; category: MarketCategory },
    outcomes: { name: string; price: number; tokenId: string }[],
    totalCost: number,
    guaranteedProfit: number
  ): Promise<Position[]> {
    const canTrade = this.canTrade();
    if (!canTrade.allowed) {
      return [];
    }

    // Calculate size (how many "sets" of all outcomes to buy)
    const portfolio = this.getPortfolio();
    const maxSize = Math.min(
      portfolio.totalValue * config.risk.maxPositionPct,
      this.balance * 0.9,
      config.sizing.maxPositionUsd
    );

    const sets = Math.floor(maxSize / totalCost);
    if (sets < 1) {
      return [];
    }

    const totalInvestment = sets * totalCost;
    const fees = totalInvestment * SIMULATED_FEE_RATE;
    const netInvestment = totalInvestment - fees;

    // Deduct from balance
    this.balance -= totalInvestment;

    const positions: Position[] = [];

    // Create position for each outcome
    for (const outcome of outcomes) {
      const outcomeSize = (netInvestment * outcome.price) / totalCost;
      const shares = outcomeSize / outcome.price;

      const position = store.createPosition({
        marketId: market.id,
        marketQuestion: market.question,
        category: market.category,
        strategy: 'arbitrage',
        side: outcome.name.toUpperCase() === 'YES' ? 'YES' : 'NO',
        outcomeId: outcome.tokenId,
        entryPrice: outcome.price,
        currentPrice: outcome.price,
        size: outcomeSize,
        shares,
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
        price: outcome.price,
        size: outcomeSize,
        shares,
        fees: fees / outcomes.length,
        timestamp: new Date(),
      });

      positions.push(position);
    }

    // Arbitrage executed - logged via dashboard

    store.savePortfolioSnapshot(this.getPortfolio());

    return positions;
  }

  updateBalance(newBalance: number): void {
    this.balance = newBalance;
  }

  resetPeakValue(): void {
    this.peakValue = this.getPortfolio().totalValue;
  }
}

export const paperExecutor = new PaperExecutor();
