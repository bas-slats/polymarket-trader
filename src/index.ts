import { config } from './config/index.js';
import { gammaClient } from './clients/gamma-client.js';
import { polymarketWS, PriceUpdate, TradeUpdate } from './clients/websocket-client.js';
import { executor } from './core/executor.js';
import { store } from './data/sqlite-store.js';
import { arbitrageStrategy } from './strategies/arbitrage.js';
import { valueBettingStrategy } from './strategies/value-betting.js';
import { whaleTracker } from './strategies/whale-tracking.js';
import { logger } from './utils/logger.js';
import { eventTrader } from './core/event-trader.js';
import { dashboard } from './ui/dashboard.js';
import type { Market, ArbitrageOpportunity, Opportunity, Portfolio } from './types/index.js';

// Ensure data directory exists
import { mkdirSync } from 'fs';
try {
  mkdirSync('./data', { recursive: true });
} catch {}

// Scan interval - 1 minute for faster opportunity detection
const SCAN_INTERVAL_MS = 60000;

class PolymarketTrader {
  private isRunning = false;
  private scanCount = 0;
  private markets: Market[] = [];
  private wsConnected = false;
  private priceUpdates = 0;
  private tradesSeen = 0;

  async start(): Promise<void> {
    dashboard.log('Starting Polymarket Trader v3.1', 'info');

    // Initialize executor (handles paper/real mode)
    await executor.initialize();

    const mode = executor.getMode().toUpperCase();
    const portfolio = await executor.getPortfolio();
    dashboard.log(`Mode: ${mode} TRADING | Balance: $${portfolio.balance.toFixed(2)}`, 'info');
    dashboard.log(`Log: ${logger.getLogFile()}`, 'info');

    if (executor.isRealMode()) {
      dashboard.log('*** REAL TRADING ENABLED - TRADES USE REAL MONEY ***', 'warning');
    }

    this.isRunning = true;

    // Initial UI update
    await this.updateDashboard();

    // Connect WebSocket for real-time data
    await this.connectWebSocket();

    // Initial market fetch
    await this.fetchMarkets();

    // Subscribe to market updates
    if (this.markets.length > 0) {
      polymarketWS.subscribeToMarkets(this.markets);
      dashboard.log(`Subscribed to ${this.markets.length} markets`, 'success');
    }

    // Initial scan
    await this.runScanCycle();

    // Set up scan interval (1 minute)
    const scanInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.runScanCycle();
      }
    }, SCAN_INTERVAL_MS);

    // Refresh markets every 5 minutes
    const marketRefreshInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.fetchMarkets();
        polymarketWS.subscribeToMarkets(this.markets);
      }
    }, 300000);

    // UI refresh interval (every 2 seconds)
    const uiInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.updateDashboard();
        dashboard.render();
      }
    }, 2000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      this.shutdown(scanInterval, marketRefreshInterval, uiInterval);
    });

    process.on('SIGTERM', () => {
      this.shutdown(scanInterval, marketRefreshInterval, uiInterval);
    });
  }

  private shutdown(
    scanInterval: NodeJS.Timeout,
    marketRefreshInterval: NodeJS.Timeout,
    uiInterval: NodeJS.Timeout
  ): void {
    this.isRunning = false;
    clearInterval(scanInterval);
    clearInterval(marketRefreshInterval);
    clearInterval(uiInterval);
    polymarketWS.disconnect();

    // Log final stats
    const portfolio = executor.getPortfolio() as Portfolio;
    const stats = store.getTotalStats();

    logger.logScan({
      timestamp: new Date().toISOString(),
      scanNumber: this.scanCount,
      marketsScanned: this.markets.length,
      eligibleMarkets: 0,
      arbitrageOpportunities: 0,
      valueOpportunities: 0,
      whaleSignals: 0,
      portfolioValue: portfolio.totalValue,
      balance: portfolio.balance,
      totalPnl: portfolio.totalPnl,
      openPositions: portfolio.openPositions.length,
      final: true,
    });

    logger.close();
    store.close();
    dashboard.destroy();

    // Print final summary to console after dashboard is destroyed
    console.log('\n\n=== FINAL REPORT ===');
    console.log(`Starting Balance: $${config.startingBalance.toFixed(2)}`);
    console.log(`Final Value: $${portfolio.totalValue.toFixed(2)}`);
    console.log(`Total P&L: ${portfolio.totalPnl >= 0 ? '+' : ''}$${portfolio.totalPnl.toFixed(2)}`);
    console.log(`Total Trades: ${stats.totalTrades}`);
    console.log(`Win Rate: ${(stats.winRate * 100).toFixed(1)}%`);

    const rtStats = eventTrader.getStats();
    console.log(`\nReal-Time Trades:`);
    console.log(`  Price-drop: ${rtStats.priceDropTrades}`);
    console.log(`  Whale-follow: ${rtStats.whaleFollowTrades}`);
    console.log(`  Arbitrage: ${rtStats.arbTrades}`);
    console.log(`  Instant exits: ${rtStats.instantExits}`);

    process.exit(0);
  }

  async connectWebSocket(): Promise<void> {
    dashboard.log('Connecting to WebSocket...', 'info');

    try {
      await polymarketWS.connect();
      this.wsConnected = true;

      // Listen for real-time price updates
      polymarketWS.on('price', (update: PriceUpdate) => {
        this.priceUpdates++;
        this.handlePriceUpdate(update);
        // Event-driven trading
        eventTrader.handlePriceUpdate(update);
        // Show in live events (only significant changes)
        if (this.priceUpdates % 10 === 0) {
          dashboard.logPriceUpdate(update.assetId, update.price);
        }
      });

      polymarketWS.on('trade', (update: TradeUpdate) => {
        this.tradesSeen++;
        this.handleTradeUpdate(update);
        // Event-driven trading
        eventTrader.handleTradeUpdate(update);
        // Show trades >= $100 in live events
        if (update.size >= 100) {
          dashboard.logLiveTrade(update.assetId, update.side, update.price, update.size);
        }
      });

      // Track real-time trades
      eventTrader.on('trade', (data: any) => {
        if (data.position) {
          dashboard.logTrade('BUY', data.position.marketQuestion, data.position.side, data.position.entryPrice, data.position.size);
        }
      });

      eventTrader.on('exit', (data: any) => {
        if (data.trade) {
          dashboard.logTrade('SELL', data.trade.marketQuestion || 'Position', data.trade.side || '', data.trade.price, data.trade.size, data.trade.pnl);
        }
      });

      polymarketWS.on('error', (error) => {
        dashboard.log(`WebSocket error: ${error.message}`, 'error');
      });

      polymarketWS.on('fatal_disconnect', () => {
        dashboard.log('WebSocket disconnected - falling back to polling', 'warning');
        this.wsConnected = false;
      });

      dashboard.log('WebSocket connected', 'success');
    } catch (error) {
      dashboard.log('WebSocket failed, using polling mode', 'warning');
      this.wsConnected = false;
    }
  }

  async fetchMarkets(): Promise<void> {
    dashboard.log('Fetching markets...', 'info');
    this.markets = await gammaClient.getActiveMarkets(300);
    dashboard.log(`Loaded ${this.markets.length} markets`, 'success');

    // Register with event trader for real-time signals
    eventTrader.registerMarkets(this.markets);
  }

  handlePriceUpdate(update: PriceUpdate): void {
    // Update market prices from WebSocket
    for (const market of this.markets) {
      for (const outcome of market.outcomes) {
        if (outcome.tokenId === update.assetId) {
          outcome.price = update.price;
        }
      }
    }

    // Update open position prices
    const positions = store.getOpenPositions();
    for (const pos of positions) {
      if (pos.outcomeId === update.assetId) {
        store.updatePositionPrice(pos.id, update.price);
      }
    }
  }

  handleTradeUpdate(update: TradeUpdate): void {
    // Track large trades for whale detection
    if (update.size >= 1000) {
      whaleTracker.recordTrade({
        assetId: update.assetId,
        price: update.price,
        size: update.size,
        side: update.side,
        timestamp: update.timestamp,
      });
    }
  }

  private async updateDashboard(): Promise<void> {
    const portfolio = await executor.getPortfolio();
    const stats = store.getTotalStats();
    const allocations = store.getAllocations();
    const rtStats = eventTrader.getStats();

    dashboard.updatePortfolio(portfolio, stats);
    dashboard.updateAllocations(allocations);
    dashboard.updateRTStats(rtStats);
    dashboard.updateWebSocketStats(this.wsConnected, this.priceUpdates, this.tradesSeen);
  }

  async runScanCycle(): Promise<void> {
    this.scanCount++;

    try {
      // Filter by liquidity
      const eligibleMarkets = this.markets.filter(
        (m) => m.liquidity >= config.trading.minMarketLiquidity
      );

      dashboard.updateScanInfo(this.scanCount, this.markets.length, eligibleMarkets.length);
      dashboard.log(`Scan #${this.scanCount}: ${eligibleMarkets.length}/${this.markets.length} eligible markets`, 'info');

      // Always check exits first (sells are always allowed)
      await this.checkExits();

      // Check if we can open new positions
      const canTrade = executor.canTrade();
      let arbOpportunities: ArbitrageOpportunity[] = [];
      let valueOpportunities: Opportunity[] = [];
      let whaleOpportunities: Opportunity[] = [];

      if (!canTrade.allowed) {
        dashboard.log(`Sell-only mode: ${canTrade.reason}`, 'warning');
      } else {
        // Scan for arbitrage opportunities
        arbOpportunities = arbitrageStrategy.scan(eligibleMarkets);
        if (arbOpportunities.length > 0) {
          dashboard.log(`Found ${arbOpportunities.length} arbitrage opportunities`, 'success');
          await this.processArbitrageOpportunities(arbOpportunities.slice(0, 3));
        }

        // Scan for value betting opportunities
        valueOpportunities = valueBettingStrategy.scan(eligibleMarkets);
        if (valueOpportunities.length > 0) {
          dashboard.log(`Found ${valueOpportunities.length} value betting opportunities`, 'success');
          await this.processValueOpportunities(valueOpportunities.slice(0, 3));
        }

        // Scan for whale signals
        whaleOpportunities = whaleTracker.getSignals(eligibleMarkets);
        if (whaleOpportunities.length > 0) {
          dashboard.log(`Found ${whaleOpportunities.length} whale signals`, 'success');
          await this.processWhaleOpportunities(whaleOpportunities.slice(0, 2));
        }
      }

      // Log scan results
      const scanPortfolio = await executor.getPortfolio();
      logger.logScan({
        timestamp: new Date().toISOString(),
        scanNumber: this.scanCount,
        marketsScanned: this.markets.length,
        eligibleMarkets: eligibleMarkets.length,
        arbitrageOpportunities: arbOpportunities.length,
        valueOpportunities: valueOpportunities.length,
        whaleSignals: whaleOpportunities.length,
        portfolioValue: scanPortfolio.totalValue,
        balance: scanPortfolio.balance,
        totalPnl: scanPortfolio.totalPnl,
        openPositions: scanPortfolio.openPositions.length,
      });

      // Update dashboard
      await this.updateDashboard();
      dashboard.render();
    } catch (error) {
      dashboard.log(`Scan error: ${error}`, 'error');
      logger.logError('Scan failed', error);
    }
  }

  async processArbitrageOpportunities(opportunities: ArbitrageOpportunity[]): Promise<void> {
    for (const opp of opportunities) {
      dashboard.logOpportunity('ARBITRAGE', opp.market.question, `${(opp.profitPercent * 100).toFixed(2)}% profit`);

      logger.logOpportunity('ARBITRAGE', opp.market.question, {
        totalCost: opp.totalCost,
        profit: opp.guaranteedProfit,
        profitPct: opp.profitPercent,
        outcomes: opp.outcomes.length,
      });

      const positions = await executor.executeArbitrageBuy(
        {
          id: opp.market.id,
          question: opp.market.question,
          category: opp.market.category,
        },
        opp.outcomes,
        opp.totalCost,
        opp.guaranteedProfit
      );

      if (positions.length > 0) {
        const totalSize = positions.reduce((sum, p) => sum + p.size, 0);
        dashboard.logTrade('BUY', opp.market.question, 'ALL', opp.totalCost, totalSize);

        logger.logTrade({
          timestamp: new Date().toISOString(),
          action: 'BUY',
          strategy: 'arbitrage',
          market: opp.market.question,
          side: 'ALL',
          price: opp.totalCost,
          size: totalSize,
          reason: `${opp.outcomes.length} outcomes, ${(opp.profitPercent * 100).toFixed(2)}% guaranteed`,
        });
      }
    }
  }

  async processValueOpportunities(opportunities: Opportunity[]): Promise<void> {
    for (const opp of opportunities) {
      dashboard.logOpportunity('VALUE', opp.market.question, `${opp.side} ${(opp.edge * 100).toFixed(1)}% edge`);

      logger.logOpportunity('VALUE', opp.market.question, {
        side: opp.side,
        price: opp.entryPrice,
        edge: opp.edge,
        confidence: opp.confidence,
      });

      const position = await executor.executeBuy(opp);
      if (position) {
        dashboard.logTrade('BUY', opp.market.question, opp.side, opp.entryPrice, position.size);

        logger.logTrade({
          timestamp: new Date().toISOString(),
          action: 'BUY',
          strategy: 'value',
          market: opp.market.question,
          side: opp.side,
          price: opp.entryPrice,
          size: position.size,
          reason: opp.reason,
        });
      }
    }
  }

  async processWhaleOpportunities(opportunities: Opportunity[]): Promise<void> {
    for (const opp of opportunities) {
      dashboard.logOpportunity('WHALE', opp.market.question, `${opp.side} ${opp.reason}`);

      logger.logOpportunity('WHALE', opp.market.question, {
        side: opp.side,
        price: opp.entryPrice,
        reason: opp.reason,
      });

      const position = await executor.executeBuy(opp);
      if (position) {
        dashboard.logTrade('BUY', opp.market.question, opp.side, opp.entryPrice, position.size);

        logger.logTrade({
          timestamp: new Date().toISOString(),
          action: 'BUY',
          strategy: 'whale',
          market: opp.market.question,
          side: opp.side,
          price: opp.entryPrice,
          size: position.size,
          reason: opp.reason,
        });
      }
    }
  }

  async checkExits(): Promise<void> {
    const positions = store.getOpenPositions();
    if (positions.length === 0) return;

    for (const position of positions) {
      // Get current price from WebSocket cache or market data
      let currentPrice = polymarketWS.getPrice(position.outcomeId);

      if (!currentPrice) {
        // Fallback to market data
        const market = this.markets.find((m) => m.id === position.marketId);
        if (market) {
          const outcome = market.outcomes.find((o) => o.id === position.outcomeId);
          if (outcome) {
            currentPrice = outcome.price;
          }
        }
      }

      if (!currentPrice) continue;

      // Update position price
      store.updatePositionPrice(position.id, currentPrice);

      // Enforce minimum hold time (60 seconds) to prevent instant flip trades
      const holdTime = Date.now() - new Date(position.entryTime).getTime();
      if (holdTime < 60000) continue;

      // Check exit conditions based on strategy
      const strategy = position.strategy === 'arbitrage' ? arbitrageStrategy : valueBettingStrategy;

      if (strategy.shouldExit(position, currentPrice)) {
        const trade = await executor.executeSell(position, currentPrice);
        if (trade) {
          dashboard.logTrade('SELL', position.marketQuestion, position.side, currentPrice, trade.size, trade.pnl);

          logger.logTrade({
            timestamp: new Date().toISOString(),
            action: 'SELL',
            strategy: position.strategy,
            market: position.marketQuestion,
            side: position.side,
            price: currentPrice,
            size: trade.size,
            pnl: trade.pnl,
            reason: `Exit at ${currentPrice.toFixed(3)}`,
          });
        }
      }
    }
  }
}

// Main
const trader = new PolymarketTrader();
trader.start().catch((error) => {
  dashboard.destroy();
  console.error('Fatal error:', error);
  process.exit(1);
});
