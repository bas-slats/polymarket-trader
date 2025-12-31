import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type {
  Position,
  Trade,
  StrategyPerformance,
  StrategyName,
  MarketCategory,
  Portfolio,
  StrategyAllocation,
} from '../types/index.js';
import { config } from '../config/index.js';

const DB_PATH = './data/trader.db';

// Ensure data directory exists
try {
  mkdirSync(dirname(DB_PATH), { recursive: true });
} catch {}

export class SQLiteStore {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      -- Positions table
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_question TEXT NOT NULL,
        category TEXT NOT NULL,
        strategy TEXT NOT NULL,
        side TEXT NOT NULL,
        outcome_id TEXT NOT NULL,
        entry_price REAL NOT NULL,
        current_price REAL NOT NULL,
        size REAL NOT NULL,
        cost REAL NOT NULL DEFAULT 0,
        shares REAL NOT NULL,
        entry_time TEXT NOT NULL,
        exit_time TEXT,
        exit_price REAL,
        pnl REAL DEFAULT 0,
        status TEXT DEFAULT 'open'
      );

      -- Trades table
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        market_question TEXT NOT NULL,
        category TEXT NOT NULL,
        strategy TEXT NOT NULL,
        side TEXT NOT NULL,
        action TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        shares REAL NOT NULL,
        fees REAL NOT NULL,
        timestamp TEXT NOT NULL,
        pnl REAL
      );

      -- Portfolio snapshots
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        balance REAL NOT NULL,
        total_value REAL NOT NULL,
        total_pnl REAL NOT NULL,
        drawdown REAL NOT NULL,
        peak_value REAL NOT NULL
      );

      -- Strategy performance
      CREATE TABLE IF NOT EXISTS strategy_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy TEXT NOT NULL,
        date TEXT NOT NULL,
        trades INTEGER NOT NULL,
        wins INTEGER NOT NULL,
        losses INTEGER NOT NULL,
        win_rate REAL NOT NULL,
        total_pnl REAL NOT NULL,
        sharpe REAL NOT NULL,
        UNIQUE(strategy, date)
      );

      -- Strategy allocations
      CREATE TABLE IF NOT EXISTS allocations (
        strategy TEXT PRIMARY KEY,
        current_weight REAL NOT NULL,
        min_weight REAL NOT NULL,
        max_weight REAL NOT NULL,
        performance_score REAL DEFAULT 0
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_strategy ON positions(strategy);
      CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
    `);

    // Initialize allocations if not exists
    this.initializeAllocations();
  }

  private initializeAllocations(): void {
    const strategies: StrategyName[] = ['arbitrage', 'value', 'whale', 'momentum', 'mean_reversion'];
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO allocations (strategy, current_weight, min_weight, max_weight, performance_score)
      VALUES (?, ?, 0.05, 0.40, 0)
    `);

    for (const strategy of strategies) {
      insert.run(strategy, config.allocations[strategy]);
    }
  }

  // Position methods
  createPosition(position: Omit<Position, 'id' | 'pnl' | 'pnlPercent' | 'status'>): Position {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO positions (id, market_id, market_question, category, strategy, side, outcome_id, entry_price, current_price, size, cost, shares, entry_time, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `);

    stmt.run(
      id,
      position.marketId,
      position.marketQuestion,
      position.category,
      position.strategy,
      position.side,
      position.outcomeId,
      position.entryPrice,
      position.currentPrice,
      position.size,
      position.cost,
      position.shares,
      position.entryTime.toISOString()
    );

    return {
      ...position,
      id,
      pnl: 0,
      pnlPercent: 0,
      status: 'open',
    };
  }

  updatePositionPrice(positionId: string, currentPrice: number): void {
    const position = this.getPosition(positionId);
    if (!position) return;

    // P&L = current value - original cost (includes fees)
    const currentValue = currentPrice * position.shares;
    const pnl = currentValue - position.cost;

    this.db.prepare(`
      UPDATE positions SET current_price = ?, pnl = ? WHERE id = ?
    `).run(currentPrice, pnl, positionId);
  }

  closePosition(positionId: string, exitPrice: number): Position | null {
    const position = this.getPosition(positionId);
    if (!position) return null;

    // P&L = exit value - original cost (includes fees)
    const exitValue = exitPrice * position.shares;
    const pnl = exitValue - position.cost;

    this.db.prepare(`
      UPDATE positions
      SET status = 'closed', exit_time = ?, exit_price = ?, current_price = ?, pnl = ?
      WHERE id = ?
    `).run(new Date().toISOString(), exitPrice, exitPrice, pnl, positionId);

    return this.getPosition(positionId);
  }

  getPosition(id: string): Position | null {
    const row = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToPosition(row);
  }

  getOpenPositions(): Position[] {
    const rows = this.db.prepare('SELECT * FROM positions WHERE status = ?').all('open') as any[];
    return rows.map(this.rowToPosition);
  }

  getPositionsByStrategy(strategy: StrategyName): Position[] {
    const rows = this.db.prepare('SELECT * FROM positions WHERE strategy = ?').all(strategy) as any[];
    return rows.map(this.rowToPosition);
  }

  private rowToPosition(row: any): Position {
    const cost = row.cost || row.size; // Fallback to size for old data
    const currentValue = row.current_price * row.shares;
    const pnl = currentValue - cost;
    const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;

    return {
      id: row.id,
      marketId: row.market_id,
      marketQuestion: row.market_question,
      category: row.category as MarketCategory,
      strategy: row.strategy as StrategyName,
      side: row.side as 'YES' | 'NO',
      outcomeId: row.outcome_id,
      entryPrice: row.entry_price,
      currentPrice: row.current_price,
      size: row.size,
      cost,
      shares: row.shares,
      entryTime: new Date(row.entry_time),
      pnl,
      pnlPercent,
      status: row.status as 'open' | 'closed',
    };
  }

  // Trade methods
  recordTrade(trade: Omit<Trade, 'id'>): Trade {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO trades (id, position_id, market_id, market_question, category, strategy, side, action, price, size, shares, fees, timestamp, pnl)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      trade.positionId,
      trade.marketId,
      trade.marketQuestion,
      trade.category,
      trade.strategy,
      trade.side,
      trade.action,
      trade.price,
      trade.size,
      trade.shares,
      trade.fees,
      trade.timestamp.toISOString(),
      trade.pnl ?? null
    );

    return { ...trade, id };
  }

  getRecentTrades(limit: number = 10): Trade[] {
    const rows = this.db.prepare(`
      SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as any[];

    return rows.map((row) => ({
      id: row.id,
      positionId: row.position_id,
      marketId: row.market_id,
      marketQuestion: row.market_question,
      category: row.category as MarketCategory,
      strategy: row.strategy as StrategyName,
      side: row.side as 'YES' | 'NO',
      action: row.action as 'BUY' | 'SELL',
      price: row.price,
      size: row.size,
      shares: row.shares,
      fees: row.fees,
      timestamp: new Date(row.timestamp),
      pnl: row.pnl,
    }));
  }

  // Strategy performance methods
  getStrategyPerformance(strategy: StrategyName): StrategyPerformance {
    const trades = this.db.prepare(`
      SELECT * FROM trades WHERE strategy = ? AND pnl IS NOT NULL
    `).all(strategy) as any[];

    const wins = trades.filter((t) => t.pnl > 0).length;
    const losses = trades.filter((t) => t.pnl <= 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    // Simple Sharpe approximation (would need daily returns for proper calc)
    const returns = trades.map((t) => t.pnl / t.size);
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = returns.length > 1
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
      : 1;
    const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0; // Annualized

    return {
      strategy,
      trades: trades.length,
      wins,
      losses,
      winRate: trades.length > 0 ? wins / trades.length : 0,
      totalPnl,
      sharpe,
      lastUpdated: new Date(),
    };
  }

  getAllStrategyPerformance(): StrategyPerformance[] {
    const strategies: StrategyName[] = ['arbitrage', 'value', 'whale', 'momentum', 'mean_reversion'];
    return strategies.map((s) => this.getStrategyPerformance(s));
  }

  // Allocation methods
  getAllocations(): StrategyAllocation[] {
    const rows = this.db.prepare('SELECT * FROM allocations').all() as any[];
    return rows.map((row) => ({
      strategy: row.strategy as StrategyName,
      currentWeight: row.current_weight,
      minWeight: row.min_weight,
      maxWeight: row.max_weight,
      performanceScore: row.performance_score,
    }));
  }

  updateAllocation(strategy: StrategyName, weight: number, performanceScore: number): void {
    this.db.prepare(`
      UPDATE allocations SET current_weight = ?, performance_score = ? WHERE strategy = ?
    `).run(weight, performanceScore, strategy);
  }

  // Portfolio snapshot
  savePortfolioSnapshot(portfolio: Portfolio): void {
    this.db.prepare(`
      INSERT INTO portfolio_snapshots (timestamp, balance, total_value, total_pnl, drawdown, peak_value)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      portfolio.balance,
      portfolio.totalValue,
      portfolio.totalPnl,
      portfolio.drawdown,
      portfolio.peakValue
    );
  }

  getLatestSnapshot(): { balance: number; peakValue: number } | null {
    const row = this.db.prepare(`
      SELECT balance, peak_value FROM portfolio_snapshots ORDER BY id DESC LIMIT 1
    `).get() as any;

    if (!row) return null;
    return { balance: row.balance, peakValue: row.peak_value };
  }

  // Stats
  getTotalStats(): { totalTrades: number; totalPnl: number; winRate: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        COALESCE(SUM(pnl), 0) as total_pnl,
        COALESCE(AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END), 0) as win_rate
      FROM trades WHERE pnl IS NOT NULL
    `).get() as any;

    return {
      totalTrades: row.total_trades,
      totalPnl: row.total_pnl,
      winRate: row.win_rate,
    };
  }

  close(): void {
    this.db.close();
  }
}

export const store = new SQLiteStore();
