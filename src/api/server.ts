import { createServer, IncomingMessage, ServerResponse } from 'http';
import { store } from '../data/sqlite-store.js';
import { executor } from '../core/executor.js';
import { eventTrader } from '../core/event-trader.js';
import type { StrategyName } from '../types/index.js';

const PORT = process.env.API_PORT || 3000;

// Simple JSON response helper
function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data, null, 2));
}

// Error response helper
function error(res: ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

// Parse URL path and query params
function parseUrl(url: string): { path: string; params: URLSearchParams } {
  const urlObj = new URL(url, 'http://localhost');
  return { path: urlObj.pathname, params: urlObj.searchParams };
}

// Route handlers
const routes: Record<string, (req: IncomingMessage, res: ServerResponse, params: URLSearchParams) => Promise<void> | void> = {
  // Health check
  'GET /api/health': (_req, res) => {
    json(res, { status: 'ok', timestamp: new Date().toISOString() });
  },

  // Portfolio overview
  'GET /api/portfolio': async (_req, res) => {
    try {
      const portfolio = await executor.getPortfolio();
      const stats = store.getTotalStats();
      const rtStats = eventTrader.getStats();

      json(res, {
        balance: portfolio.balance,
        totalValue: portfolio.totalValue,
        totalPnl: portfolio.totalPnl,
        drawdown: portfolio.drawdown,
        peakValue: portfolio.peakValue,
        openPositionsCount: portfolio.openPositions.length,
        stats: {
          totalTrades: stats.totalTrades,
          totalPnl: stats.totalPnl,
          winRate: stats.winRate,
        },
        realTimeStats: rtStats,
      });
    } catch (err) {
      error(res, `Failed to get portfolio: ${err}`, 500);
    }
  },

  // All open positions
  'GET /api/positions': (_req, res) => {
    try {
      const positions = store.getOpenPositions();
      json(res, {
        count: positions.length,
        positions: positions.map((p) => ({
          id: p.id,
          market: p.marketQuestion,
          category: p.category,
          strategy: p.strategy,
          side: p.side,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice,
          size: p.size,
          shares: p.shares,
          pnl: p.pnl,
          pnlPercent: p.pnlPercent,
          entryTime: p.entryTime,
        })),
      });
    } catch (err) {
      error(res, `Failed to get positions: ${err}`, 500);
    }
  },

  // Positions by strategy
  'GET /api/positions/:strategy': (_req, res, params) => {
    try {
      const strategy = params.get('strategy') as StrategyName;
      if (!strategy) {
        return error(res, 'Strategy parameter required');
      }

      const validStrategies = ['arbitrage', 'value', 'whale', 'momentum', 'mean_reversion'];
      if (!validStrategies.includes(strategy)) {
        return error(res, `Invalid strategy. Valid: ${validStrategies.join(', ')}`);
      }

      const positions = store.getPositionsByStrategy(strategy);
      json(res, {
        strategy,
        count: positions.length,
        positions: positions.map((p) => ({
          id: p.id,
          market: p.marketQuestion,
          side: p.side,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice,
          size: p.size,
          pnl: p.pnl,
          pnlPercent: p.pnlPercent,
          status: p.status,
          entryTime: p.entryTime,
        })),
      });
    } catch (err) {
      error(res, `Failed to get positions: ${err}`, 500);
    }
  },

  // Recent trades
  'GET /api/trades': (_req, res, params) => {
    try {
      const limit = parseInt(params.get('limit') || '50');
      const trades = store.getRecentTrades(Math.min(limit, 100));
      json(res, {
        count: trades.length,
        trades: trades.map((t) => ({
          id: t.id,
          market: t.marketQuestion,
          category: t.category,
          strategy: t.strategy,
          side: t.side,
          action: t.action,
          price: t.price,
          size: t.size,
          shares: t.shares,
          fees: t.fees,
          pnl: t.pnl,
          timestamp: t.timestamp,
        })),
      });
    } catch (err) {
      error(res, `Failed to get trades: ${err}`, 500);
    }
  },

  // Strategy performance
  'GET /api/strategies': (_req, res) => {
    try {
      const performance = store.getAllStrategyPerformance();
      const allocations = store.getAllocations();

      const strategies = performance.map((p) => {
        const alloc = allocations.find((a) => a.strategy === p.strategy);
        return {
          strategy: p.strategy,
          trades: p.trades,
          wins: p.wins,
          losses: p.losses,
          winRate: p.winRate,
          totalPnl: p.totalPnl,
          sharpe: p.sharpe,
          allocation: alloc?.currentWeight || 0,
        };
      });

      json(res, { strategies });
    } catch (err) {
      error(res, `Failed to get strategies: ${err}`, 500);
    }
  },

  // Single strategy performance
  'GET /api/strategies/:strategy': (_req, res, params) => {
    try {
      const strategy = params.get('strategy') as StrategyName;
      if (!strategy) {
        return error(res, 'Strategy parameter required');
      }

      const validStrategies = ['arbitrage', 'value', 'whale', 'momentum', 'mean_reversion'];
      if (!validStrategies.includes(strategy)) {
        return error(res, `Invalid strategy. Valid: ${validStrategies.join(', ')}`);
      }

      const performance = store.getStrategyPerformance(strategy);
      const allocations = store.getAllocations();
      const alloc = allocations.find((a) => a.strategy === strategy);
      const positions = store.getPositionsByStrategy(strategy);

      json(res, {
        strategy: performance.strategy,
        trades: performance.trades,
        wins: performance.wins,
        losses: performance.losses,
        winRate: performance.winRate,
        totalPnl: performance.totalPnl,
        sharpe: performance.sharpe,
        allocation: alloc?.currentWeight || 0,
        openPositions: positions.filter((p) => p.status === 'open').length,
        closedPositions: positions.filter((p) => p.status === 'closed').length,
      });
    } catch (err) {
      error(res, `Failed to get strategy: ${err}`, 500);
    }
  },

  // Allocations
  'GET /api/allocations': (_req, res) => {
    try {
      const allocations = store.getAllocations();
      json(res, {
        allocations: allocations.map((a) => ({
          strategy: a.strategy,
          currentWeight: a.currentWeight,
          minWeight: a.minWeight,
          maxWeight: a.maxWeight,
          performanceScore: a.performanceScore,
        })),
      });
    } catch (err) {
      error(res, `Failed to get allocations: ${err}`, 500);
    }
  },

  // Total stats
  'GET /api/stats': (_req, res) => {
    try {
      const stats = store.getTotalStats();
      const rtStats = eventTrader.getStats();

      json(res, {
        totalTrades: stats.totalTrades,
        totalPnl: stats.totalPnl,
        winRate: stats.winRate,
        realTimeStats: {
          priceDropTrades: rtStats.priceDropTrades,
          whaleFollowTrades: rtStats.whaleFollowTrades,
          arbTrades: rtStats.arbTrades,
          instantExits: rtStats.instantExits,
        },
      });
    } catch (err) {
      error(res, `Failed to get stats: ${err}`, 500);
    }
  },

  // Summary (dashboard-friendly)
  'GET /api/summary': async (_req, res) => {
    try {
      const portfolio = await executor.getPortfolio();
      const stats = store.getTotalStats();
      const rtStats = eventTrader.getStats();
      const allocations = store.getAllocations();
      const recentTrades = store.getRecentTrades(5);
      const openPositions = store.getOpenPositions();

      json(res, {
        portfolio: {
          balance: portfolio.balance,
          totalValue: portfolio.totalValue,
          totalPnl: portfolio.totalPnl,
          pnlPercent: portfolio.balance > 0 ? (portfolio.totalPnl / portfolio.balance) * 100 : 0,
          drawdown: portfolio.drawdown,
        },
        stats: {
          totalTrades: stats.totalTrades,
          winRate: (stats.winRate * 100).toFixed(1) + '%',
          rtPriceDrops: rtStats.priceDropTrades,
          rtWhaleFollows: rtStats.whaleFollowTrades,
          rtArbitrage: rtStats.arbTrades,
          rtExits: rtStats.instantExits,
        },
        allocations: allocations.reduce((acc, a) => {
          acc[a.strategy] = (a.currentWeight * 100).toFixed(0) + '%';
          return acc;
        }, {} as Record<string, string>),
        openPositions: openPositions.length,
        recentTrades: recentTrades.map((t) => ({
          action: t.action,
          strategy: t.strategy,
          market: t.marketQuestion.substring(0, 50) + (t.marketQuestion.length > 50 ? '...' : ''),
          pnl: t.pnl,
          time: t.timestamp,
        })),
      });
    } catch (err) {
      error(res, `Failed to get summary: ${err}`, 500);
    }
  },
};

// Request handler
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method || 'GET';
  const { path, params } = parseUrl(req.url || '/');

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Match route with path parameters
  let routeKey = `${method} ${path}`;
  let handler = routes[routeKey];

  // Check for parameterized routes (e.g., /api/positions/:strategy)
  if (!handler) {
    for (const [pattern, h] of Object.entries(routes)) {
      const [patternMethod, patternPath] = pattern.split(' ');
      if (patternMethod !== method) continue;

      const patternParts = patternPath.split('/');
      const pathParts = path.split('/');

      if (patternParts.length !== pathParts.length) continue;

      let match = true;
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
          params.set(patternParts[i].substring(1), pathParts[i]);
        } else if (patternParts[i] !== pathParts[i]) {
          match = false;
          break;
        }
      }

      if (match) {
        handler = h;
        break;
      }
    }
  }

  if (handler) {
    try {
      await handler(req, res, params);
    } catch (err) {
      error(res, `Server error: ${err}`, 500);
    }
  } else {
    // API documentation
    if (path === '/api' || path === '/') {
      json(res, {
        name: 'Polymarket Trader API',
        version: '1.0.0',
        endpoints: [
          { method: 'GET', path: '/api/health', description: 'Health check' },
          { method: 'GET', path: '/api/portfolio', description: 'Portfolio overview with P&L' },
          { method: 'GET', path: '/api/positions', description: 'All open positions' },
          { method: 'GET', path: '/api/positions/:strategy', description: 'Positions by strategy' },
          { method: 'GET', path: '/api/trades?limit=N', description: 'Recent trades (max 100)' },
          { method: 'GET', path: '/api/strategies', description: 'All strategy performance' },
          { method: 'GET', path: '/api/strategies/:strategy', description: 'Single strategy details' },
          { method: 'GET', path: '/api/allocations', description: 'Strategy allocations' },
          { method: 'GET', path: '/api/stats', description: 'Overall trading stats' },
          { method: 'GET', path: '/api/summary', description: 'Dashboard-friendly summary' },
        ],
      });
    } else {
      error(res, `Route not found: ${method} ${path}`, 404);
    }
  }
}

// Create and start server
export function startApiServer(): void {
  const server = createServer(handleRequest);

  server.listen(PORT, () => {
    console.log(`API server running on http://localhost:${PORT}`);
    console.log(`Endpoints: http://localhost:${PORT}/api`);
  });
}

// Allow running standalone
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  // Initialize executor first
  executor.initialize().then(() => {
    startApiServer();
  });
}
