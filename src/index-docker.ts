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
import type { Market, ArbitrageOpportunity, Opportunity, Portfolio } from './types/index.js';

// Ensure data directory exists
import { mkdirSync } from 'fs';
try {
  mkdirSync('./data', { recursive: true });
} catch {}

// Scan interval - 1 minute for faster opportunity detection
const SCAN_INTERVAL_MS = 60000;

// Format P&L with color indicator
function formatPnL(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '';
  return `${sign}$${pnl.toFixed(2)}`;
}

// Log with timestamp and P&L
function logEvent(
  event: string,
  details: string,
  portfolio: { totalValue: number; totalPnl: number; balance: number }
): void {
  const ts = new Date().toISOString().substring(11, 19);
  const pnlStr = formatPnL(portfolio.totalPnl);
  const valueStr = `$${portfolio.totalValue.toFixed(2)}`;
  console.log(`[${ts}] ${event.padEnd(12)} | ${details.padEnd(60)} | Value: ${valueStr} | P&L: ${pnlStr}`);
}

class DockerTrader {
  private isRunning = false;
  private scanCount = 0;
  private markets: Market[] = [];
  private wsConnected = false;

  async start(): Promise<void> {
    console.log('='.repeat(100));
    console.log('POLYMARKET TRADER v3.1 - Docker Mode');
    console.log('='.repeat(100));

    // Initialize executor (handles paper/real mode)
    await executor.initialize();

    const mode = executor.getMode().toUpperCase();
    const portfolio = await executor.getPortfolio();
    console.log(`Mode: ${mode} TRADING | Starting Balance: $${portfolio.balance.toFixed(2)}`);
    console.log(`Log file: ${logger.getLogFile()}`);

    if (executor.isRealMode()) {
      console.log('*** WARNING: REAL TRADING ENABLED - TRADES USE REAL MONEY ***');
    }

    console.log('='.repeat(100));
    console.log(`${'Time'.padEnd(10)} | ${'Event'.padEnd(12)} | ${'Details'.padEnd(60)} | Value       | P&L`);
    console.log('-'.repeat(100));

    this.isRunning = true;

    // Connect WebSocket for real-time data
    await this.connectWebSocket();

    // Initial market fetch
    await this.fetchMarkets();

    // Subscribe to market updates
    if (this.markets.length > 0) {
      polymarketWS.subscribeToMarkets(this.markets);
      const p = await executor.getPortfolio();
      logEvent('SUBSCRIBED', `${this.markets.length} markets`, p);
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

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown(scanInterval, marketRefreshInterval));
    process.on('SIGTERM', () => this.shutdown(scanInterval, marketRefreshInterval));
  }

  private shutdown(scanInterval: NodeJS.Timeout, marketRefreshInterval: NodeJS.Timeout): void {
    this.isRunning = false;
    clearInterval(scanInterval);
    clearInterval(marketRefreshInterval);
    polymarketWS.disconnect();

    // Log final stats
    const portfolio = executor.getPortfolio() as Portfolio;
    const stats = store.getTotalStats();
    const rtStats = eventTrader.getStats();

    console.log('\n' + '='.repeat(100));
    console.log('FINAL REPORT');
    console.log('='.repeat(100));
    console.log(`Starting Balance: $${config.startingBalance.toFixed(2)}`);
    console.log(`Final Value:      $${portfolio.totalValue.toFixed(2)}`);
    console.log(`Total P&L:        ${formatPnL(portfolio.totalPnl)}`);
    console.log(`Return:           ${((portfolio.totalPnl / config.startingBalance) * 100).toFixed(2)}%`);
    console.log(`Total Trades:     ${stats.totalTrades}`);
    console.log(`Win Rate:         ${(stats.winRate * 100).toFixed(1)}%`);
    console.log(`\nReal-Time Trades:`);
    console.log(`  Price-drop:     ${rtStats.priceDropTrades}`);
    console.log(`  Whale-follow:   ${rtStats.whaleFollowTrades}`);
    console.log(`  Arbitrage:      ${rtStats.arbTrades}`);
    console.log(`  Instant exits:  ${rtStats.instantExits}`);
    console.log('='.repeat(100));

    logger.close();
    store.close();
    process.exit(0);
  }

  async connectWebSocket(): Promise<void> {
    try {
      await polymarketWS.connect();
      this.wsConnected = true;
      const p = await executor.getPortfolio();
      logEvent('WS_CONNECT', 'WebSocket connected to Polymarket', p);

      // Listen for real-time price updates
      polymarketWS.on('price', (update: PriceUpdate) => {
        this.handlePriceUpdate(update);
        eventTrader.handlePriceUpdate(update);
      });

      polymarketWS.on('trade', (update: TradeUpdate) => {
        this.handleTradeUpdate(update);
        eventTrader.handleTradeUpdate(update);

        // Log large trades
        if (update.size >= 1000) {
          Promise.resolve(executor.getPortfolio()).then((p: Portfolio) => {
            logEvent('WHALE_TRADE', `$${update.size.toFixed(0)} ${update.side} @ ${update.price.toFixed(3)}`, p);
          });
        }
      });

      // Track real-time trades
      eventTrader.on('trade', async (data: any) => {
        if (data.position) {
          const p = await executor.getPortfolio();
          const market = data.position.marketQuestion.substring(0, 50);
          logEvent('RT_BUY', `${data.type} | ${market}... | ${data.position.side} @ $${data.position.entryPrice.toFixed(3)} | Size: $${data.position.size.toFixed(2)}`, p);
        }
      });

      eventTrader.on('exit', async (data: any) => {
        if (data.trade) {
          const p = await executor.getPortfolio();
          const pnlStr = data.trade.pnl >= 0 ? `+$${data.trade.pnl.toFixed(2)}` : `-$${Math.abs(data.trade.pnl).toFixed(2)}`;
          logEvent('RT_SELL', `Exit | ${pnlStr} | Size: $${data.trade.size.toFixed(2)}`, p);
        }
      });

      polymarketWS.on('fatal_disconnect', async () => {
        const p = await executor.getPortfolio();
        logEvent('WS_LOST', 'WebSocket disconnected - polling mode', p);
        this.wsConnected = false;
      });
    } catch (error) {
      const p = await executor.getPortfolio();
      logEvent('WS_FAIL', 'WebSocket failed, using polling mode', p);
      this.wsConnected = false;
    }
  }

  async fetchMarkets(): Promise<void> {
    this.markets = await gammaClient.getActiveMarkets(300);
    eventTrader.registerMarkets(this.markets);
  }

  handlePriceUpdate(update: PriceUpdate): void {
    for (const market of this.markets) {
      for (const outcome of market.outcomes) {
        if (outcome.tokenId === update.assetId) {
          outcome.price = update.price;
        }
      }
    }

    const positions = store.getOpenPositions();
    for (const pos of positions) {
      if (pos.outcomeId === update.assetId) {
        store.updatePositionPrice(pos.id, update.price);
      }
    }
  }

  handleTradeUpdate(update: TradeUpdate): void {
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

  async runScanCycle(): Promise<void> {
    this.scanCount++;

    try {
      const eligibleMarkets = this.markets.filter(
        (m) => m.liquidity >= config.trading.minMarketLiquidity
      );

      // Always check exits first (sells are always allowed)
      await this.checkExits();

      // Check if we can open new positions
      const canTrade = executor.canTrade();
      let arbOpportunities: any[] = [];
      let valueOpportunities: any[] = [];
      let whaleOpportunities: any[] = [];

      if (!canTrade.allowed) {
        const p = await executor.getPortfolio();
        logEvent('SELL_ONLY', canTrade.reason || 'New buys halted', p);
      } else {
        // Scan for arbitrage opportunities
        arbOpportunities = arbitrageStrategy.scan(eligibleMarkets);
        if (arbOpportunities.length > 0) {
          await this.processArbitrageOpportunities(arbOpportunities.slice(0, 3));
        }

        // Scan for value betting opportunities
        valueOpportunities = valueBettingStrategy.scan(eligibleMarkets);
        if (valueOpportunities.length > 0) {
          await this.processValueOpportunities(valueOpportunities.slice(0, 3));
        }

        // Scan for whale signals
        whaleOpportunities = whaleTracker.getSignals(eligibleMarkets);
        if (whaleOpportunities.length > 0) {
          await this.processWhaleOpportunities(whaleOpportunities.slice(0, 2));
        }
      }

      // Log scan summary
      const p = await executor.getPortfolio();
      const positions = store.getOpenPositions();
      logEvent('SCAN', `#${this.scanCount} | ${eligibleMarkets.length} mkts | ${positions.length} pos | Arb:${arbOpportunities.length} Val:${valueOpportunities.length} Whale:${whaleOpportunities.length}`, p);

      // Log scan to file
      logger.logScan({
        timestamp: new Date().toISOString(),
        scanNumber: this.scanCount,
        marketsScanned: this.markets.length,
        eligibleMarkets: eligibleMarkets.length,
        arbitrageOpportunities: arbOpportunities.length,
        valueOpportunities: valueOpportunities.length,
        whaleSignals: whaleOpportunities.length,
        portfolioValue: p.totalValue,
        balance: p.balance,
        totalPnl: p.totalPnl,
        openPositions: p.openPositions.length,
      });
    } catch (error) {
      const p = await executor.getPortfolio();
      logEvent('ERROR', `Scan error: ${error}`, p);
      logger.logError('Scan failed', error);
    }
  }

  async processArbitrageOpportunities(opportunities: ArbitrageOpportunity[]): Promise<void> {
    for (const opp of opportunities) {
      logger.logOpportunity('ARBITRAGE', opp.market.question, {
        totalCost: opp.totalCost,
        profit: opp.guaranteedProfit,
        profitPct: opp.profitPercent,
      });

      const positions = await executor.executeArbitrageBuy(
        { id: opp.market.id, question: opp.market.question, category: opp.market.category },
        opp.outcomes,
        opp.totalCost,
        opp.guaranteedProfit
      );

      if (positions.length > 0) {
        const p = await executor.getPortfolio();
        const totalSize = positions.reduce((sum, pos) => sum + pos.size, 0);
        const market = opp.market.question.substring(0, 40);
        logEvent('ARB_BUY', `${market}... | ${(opp.profitPercent * 100).toFixed(2)}% profit | Size: $${totalSize.toFixed(2)}`, p);

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
      logger.logOpportunity('VALUE', opp.market.question, {
        side: opp.side,
        price: opp.entryPrice,
        edge: opp.edge,
        confidence: opp.confidence,
      });

      const position = await executor.executeBuy(opp);
      if (position) {
        const p = await executor.getPortfolio();
        const market = opp.market.question.substring(0, 40);
        logEvent('VALUE_BUY', `${market}... | ${opp.side} @ $${opp.entryPrice.toFixed(3)} | Edge: ${(opp.edge * 100).toFixed(1)}% | Size: $${position.size.toFixed(2)}`, p);

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
      logger.logOpportunity('WHALE', opp.market.question, {
        side: opp.side,
        price: opp.entryPrice,
        reason: opp.reason,
      });

      const position = await executor.executeBuy(opp);
      if (position) {
        const p = await executor.getPortfolio();
        const market = opp.market.question.substring(0, 40);
        logEvent('WHALE_BUY', `${market}... | ${opp.side} @ $${opp.entryPrice.toFixed(3)} | Size: $${position.size.toFixed(2)}`, p);

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
      let currentPrice = polymarketWS.getPrice(position.outcomeId);

      if (!currentPrice) {
        const market = this.markets.find((m) => m.id === position.marketId);
        if (market) {
          const outcome = market.outcomes.find((o) => o.id === position.outcomeId);
          if (outcome) {
            currentPrice = outcome.price;
          }
        }
      }

      if (!currentPrice) continue;

      store.updatePositionPrice(position.id, currentPrice);

      // Enforce minimum hold time (60 seconds) to prevent instant flip trades
      const holdTime = Date.now() - new Date(position.entryTime).getTime();
      if (holdTime < 60000) continue;

      const strategy = position.strategy === 'arbitrage' ? arbitrageStrategy : valueBettingStrategy;

      if (strategy.shouldExit(position, currentPrice)) {
        const trade = await executor.executeSell(position, currentPrice);
        if (trade) {
          const p = await executor.getPortfolio();
          const pnl = trade.pnl ?? 0;
          const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
          const market = position.marketQuestion.substring(0, 40);
          logEvent('SELL', `${market}... | ${position.side} @ $${currentPrice.toFixed(3)} | ${pnlStr}`, p);

          logger.logTrade({
            timestamp: new Date().toISOString(),
            action: 'SELL',
            strategy: position.strategy,
            market: position.marketQuestion,
            side: position.side,
            price: currentPrice,
            size: trade.size,
            pnl,
            reason: `Exit at ${currentPrice.toFixed(3)}`,
          });
        }
      }
    }
  }
}

// Main
const trader = new DockerTrader();
trader.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
