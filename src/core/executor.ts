import type {
  Opportunity,
  Position,
  Trade,
  Portfolio,
  MarketCategory,
} from '../types/index.js';
import { paperExecutor } from './paper-executor.js';
import { realExecutor } from './real-executor.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import * as readline from 'readline';

// Global deduplication - prevents duplicate transactions across all code paths
const pendingBuys = new Map<string, number>(); // marketId+side -> timestamp
const pendingSells = new Set<string>(); // positionId
const BUY_COOLDOWN_MS = 5000; // 5 second cooldown between buys for same market+side

// Real trading requires explicit confirmation
const REAL_TRADING_WARNING = `
================================================================================
                         REAL TRADING MODE ENABLED
================================================================================

You are about to trade with REAL MONEY on Polymarket.

- All trades will use your actual USDC balance
- Losses are REAL and cannot be reversed
- The bot will make autonomous trading decisions
- There are NO guarantees of profit

Make sure you understand the risks before proceeding.

================================================================================
`;

export interface Executor {
  getPortfolio(): Portfolio | Promise<Portfolio>;
  canTrade(): { allowed: boolean; reason?: string };
  calculatePositionSize(opportunity: Opportunity): number;
  executeBuy(opportunity: Opportunity): Promise<Position | null>;
  executeSell(position: Position, currentPrice: number): Promise<Trade | null>;
  executeArbitrageBuy(
    market: { id: string; question: string; category: MarketCategory },
    outcomes: { name: string; price: number; tokenId: string }[],
    totalCost: number,
    guaranteedProfit: number
  ): Promise<Position[]>;
}

class UnifiedExecutor implements Executor {
  private mode: 'paper' | 'real' = 'paper';
  private realModeConfirmed = false;

  async initialize(): Promise<void> {
    if (config.paperMode) {
      this.mode = 'paper';
      logger.log('INFO', 'Initialized in PAPER trading mode');
      return;
    }

    // Real trading mode
    if (!config.api.address || !config.api.privateKey) {
      logger.log('WARN', 'POLYMARKET_ID and POLYMARKET_KEY not set, falling back to paper mode');
      this.mode = 'paper';
      return;
    }

    // Require explicit confirmation for real trading
    const confirmed = await this.confirmRealTrading();
    if (!confirmed) {
      logger.log('INFO', 'Real trading not confirmed, falling back to paper mode');
      this.mode = 'paper';
      return;
    }

    try {
      await realExecutor.initialize();
      this.mode = 'real';
      this.realModeConfirmed = true;
      logger.log('INFO', 'Initialized in REAL trading mode', {
        address: config.api.address,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.log('ERROR', 'Failed to initialize real trading, falling back to paper mode', {
        error: message,
      });
      this.mode = 'paper';
    }
  }

  private async confirmRealTrading(): Promise<boolean> {
    // If running non-interactively (e.g., in CI), skip confirmation
    if (!process.stdin.isTTY) {
      logger.log('WARN', 'Non-interactive mode detected, skipping real trading confirmation');
      return false;
    }

    return new Promise((resolve) => {
      console.log(REAL_TRADING_WARNING);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question('Type "CONFIRM" to enable real trading, or anything else to use paper mode: ', (answer) => {
        rl.close();
        if (answer.trim().toUpperCase() === 'CONFIRM') {
          console.log('\nReal trading ENABLED. Be careful!\n');
          resolve(true);
        } else {
          console.log('\nPaper trading mode enabled.\n');
          resolve(false);
        }
      });

      // Timeout after 30 seconds - default to paper mode
      setTimeout(() => {
        rl.close();
        console.log('\nConfirmation timeout - defaulting to paper mode.\n');
        resolve(false);
      }, 30000);
    });
  }

  isRealMode(): boolean {
    return this.mode === 'real' && this.realModeConfirmed;
  }

  getMode(): 'paper' | 'real' {
    return this.mode;
  }

  getPortfolio(): Portfolio | Promise<Portfolio> {
    if (this.mode === 'real') {
      return realExecutor.getPortfolio();
    }
    return paperExecutor.getPortfolio();
  }

  canTrade(): { allowed: boolean; reason?: string } {
    if (this.mode === 'real') {
      return realExecutor.canTrade();
    }
    return paperExecutor.canTrade();
  }

  calculatePositionSize(opportunity: Opportunity): number {
    if (this.mode === 'real') {
      return realExecutor.calculatePositionSize(opportunity);
    }
    return paperExecutor.calculatePositionSize(opportunity);
  }

  async executeBuy(opportunity: Opportunity): Promise<Position | null> {
    // Deduplication: prevent buying same market+side within cooldown
    const buyKey = `${opportunity.market.id}|${opportunity.side}`;
    const now = Date.now();
    const lastBuy = pendingBuys.get(buyKey);

    if (lastBuy && now - lastBuy < BUY_COOLDOWN_MS) {
      logger.log('INFO', 'Buy skipped - duplicate within cooldown', {
        market: opportunity.market.question.substring(0, 40),
        side: opportunity.side,
        cooldownRemaining: BUY_COOLDOWN_MS - (now - lastBuy),
      });
      return null;
    }

    // Mark as pending BEFORE execution
    pendingBuys.set(buyKey, now);

    try {
      if (this.mode === 'real') {
        logger.log('INFO', 'REAL TRADE: Executing BUY', {
          market: opportunity.market.question,
          side: opportunity.side,
          price: opportunity.entryPrice,
          edge: opportunity.edge,
          confidence: opportunity.confidence,
        });
        return await realExecutor.executeBuy(opportunity);
      }
      return await paperExecutor.executeBuy(opportunity);
    } catch (error) {
      // On error, remove from pending to allow retry
      pendingBuys.delete(buyKey);
      throw error;
    }
  }

  async executeSell(position: Position, currentPrice: number): Promise<Trade | null> {
    // Deduplication: prevent selling same position multiple times
    if (pendingSells.has(position.id)) {
      logger.log('INFO', 'Sell skipped - already pending', {
        positionId: position.id,
        market: position.marketQuestion.substring(0, 40),
      });
      return null;
    }

    // Mark as pending BEFORE execution
    pendingSells.add(position.id);

    try {
      if (this.mode === 'real') {
        logger.log('INFO', 'REAL TRADE: Executing SELL', {
          market: position.marketQuestion,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: currentPrice,
          shares: position.shares,
        });
        return await realExecutor.executeSell(position, currentPrice);
      }
      return await paperExecutor.executeSell(position, currentPrice);
    } finally {
      // Always remove from pending after execution (success or failure)
      pendingSells.delete(position.id);
    }
  }

  async executeArbitrageBuy(
    market: { id: string; question: string; category: MarketCategory },
    outcomes: { name: string; price: number; tokenId: string }[],
    totalCost: number,
    guaranteedProfit: number
  ): Promise<Position[]> {
    if (this.mode === 'real') {
      logger.log('INFO', 'REAL TRADE: Executing ARBITRAGE', {
        market: market.question,
        totalCost,
        profit: guaranteedProfit,
        outcomes: outcomes.length,
      });
      return realExecutor.executeArbitrageBuy(market, outcomes, totalCost, guaranteedProfit);
    }
    return paperExecutor.executeArbitrageBuy(market, outcomes, totalCost, guaranteedProfit);
  }
}

export const executor = new UnifiedExecutor();
