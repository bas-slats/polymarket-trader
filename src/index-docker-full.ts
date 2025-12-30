/**
 * Docker entry point with both trader and web UI
 * Runs the headless trader with console logging + API server for web dashboard
 */

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
import { startApiServer } from './api/server.js';
import type { Market, ArbitrageOpportunity, Opportunity, Portfolio } from './types/index.js';

// Ensure data directory exists
import { mkdirSync } from 'fs';
try {
  mkdirSync('./data', { recursive: true });
} catch {}

const SCAN_INTERVAL_MS = 60000;

function formatPnL(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '';
  return `${sign}$${pnl.toFixed(2)}`;
}

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

class DockerTraderWithUI {
  private isRunning = false;
  private scanCount = 0;
  private markets: Market[] = [];
  private wsConnected = false;

  async start(): Promise<void> {
    console.log('='.repeat(100));
    console.log('POLYMARKET TRADER v3.1 - Docker Mode with Web UI');
    console.log('='.repeat(100));

    await executor.initialize();

    const mode = executor.getMode().toUpperCase();
    const portfolio = await executor.getPortfolio();
    console.log(`Mode: ${mode} TRADING | Starting Balance: $${portfolio.balance.toFixed(2)}`);

    if (executor.isRealMode()) {
      console.log('*** WARNING: REAL TRADING ENABLED ***');
    }

    // Start API server for web dashboard
    startApiServer();

    console.log('='.repeat(100));
    console.log(`${'Time'.padEnd(10)} | ${'Event'.padEnd(12)} | ${'Details'.padEnd(60)} | Value       | P&L`);
    console.log('-'.repeat(100));

    this.isRunning = true;

    await this.connectWebSocket();
    await this.fetchMarkets();

    if (this.markets.length > 0) {
      polymarketWS.subscribeToMarkets(this.markets);
      const p = await executor.getPortfolio();
      logEvent('SUBSCRIBED', `${this.markets.length} markets`, p);
    }

    await this.runScanCycle();

    const scanInterval = setInterval(async () => {
      if (this.isRunning) await this.runScanCycle();
    }, SCAN_INTERVAL_MS);

    const marketRefreshInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.fetchMarkets();
        polymarketWS.subscribeToMarkets(this.markets);
      }
    }, 300000);

    process.on('SIGINT', () => this.shutdown(scanInterval, marketRefreshInterval));
    process.on('SIGTERM', () => this.shutdown(scanInterval, marketRefreshInterval));
  }

  private shutdown(scanInterval: NodeJS.Timeout, marketRefreshInterval: NodeJS.Timeout): void {
    this.isRunning = false;
    clearInterval(scanInterval);
    clearInterval(marketRefreshInterval);
    polymarketWS.disconnect();

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

      polymarketWS.on('price', (update: PriceUpdate) => {
        this.handlePriceUpdate(update);
        eventTrader.handlePriceUpdate(update);
      });

      polymarketWS.on('trade', (update: TradeUpdate) => {
        this.handleTradeUpdate(update);
        eventTrader.handleTradeUpdate(update);

        if (update.size >= 1000) {
          Promise.resolve(executor.getPortfolio()).then((p: Portfolio) => {
            logEvent('WHALE_TRADE', `$${update.size.toFixed(0)} ${update.side} @ ${update.price.toFixed(3)}`, p);
          });
        }
      });

      eventTrader.on('trade', async (data: any) => {
        if (data.position) {
          const p = await executor.getPortfolio();
          const market = data.position.marketQuestion.substring(0, 50);
          logEvent('RT_BUY', `${data.type} | ${market}... | ${data.position.side} @ $${data.position.entryPrice.toFixed(3)}`, p);
        }
      });

      eventTrader.on('exit', async (data: any) => {
        if (data.trade) {
          const p = await executor.getPortfolio();
          const pnl = data.trade.pnl ?? 0;
          const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
          logEvent('RT_SELL', `Exit | ${pnlStr} | Size: $${data.trade.size.toFixed(2)}`, p);
        }
      });

      polymarketWS.on('fatal_disconnect', async () => {
        const p = await executor.getPortfolio();
        logEvent('WS_LOST', 'WebSocket disconnected', p);
        this.wsConnected = false;
      });
    } catch {
      const p = await executor.getPortfolio();
      logEvent('WS_FAIL', 'WebSocket failed, polling mode', p);
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
        // Scan for new opportunities only if allowed
        arbOpportunities = arbitrageStrategy.scan(eligibleMarkets);
        if (arbOpportunities.length > 0) {
          await this.processArbitrageOpportunities(arbOpportunities.slice(0, 3));
        }

        valueOpportunities = valueBettingStrategy.scan(eligibleMarkets);
        if (valueOpportunities.length > 0) {
          await this.processValueOpportunities(valueOpportunities.slice(0, 3));
        }

        whaleOpportunities = whaleTracker.getSignals(eligibleMarkets);
        if (whaleOpportunities.length > 0) {
          await this.processWhaleOpportunities(whaleOpportunities.slice(0, 2));
        }
      }

      const p = await executor.getPortfolio();
      const positions = store.getOpenPositions();
      logEvent('SCAN', `#${this.scanCount} | ${eligibleMarkets.length} mkts | ${positions.length} pos`, p);

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
    }
  }

  async processArbitrageOpportunities(opportunities: ArbitrageOpportunity[]): Promise<void> {
    for (const opp of opportunities) {
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
        logEvent('ARB_BUY', `${market}... | ${(opp.profitPercent * 100).toFixed(2)}% | $${totalSize.toFixed(2)}`, p);
      }
    }
  }

  async processValueOpportunities(opportunities: Opportunity[]): Promise<void> {
    for (const opp of opportunities) {
      const position = await executor.executeBuy(opp);
      if (position) {
        const p = await executor.getPortfolio();
        const market = opp.market.question.substring(0, 40);
        logEvent('VALUE_BUY', `${market}... | ${opp.side} | Edge: ${(opp.edge * 100).toFixed(1)}%`, p);
      }
    }
  }

  async processWhaleOpportunities(opportunities: Opportunity[]): Promise<void> {
    for (const opp of opportunities) {
      const position = await executor.executeBuy(opp);
      if (position) {
        const p = await executor.getPortfolio();
        const market = opp.market.question.substring(0, 40);
        logEvent('WHALE_BUY', `${market}... | ${opp.side} @ $${opp.entryPrice.toFixed(3)}`, p);
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
          if (outcome) currentPrice = outcome.price;
        }
      }

      if (!currentPrice) continue;

      store.updatePositionPrice(position.id, currentPrice);

      const strategy = position.strategy === 'arbitrage' ? arbitrageStrategy : valueBettingStrategy;

      if (strategy.shouldExit(position, currentPrice)) {
        const trade = await executor.executeSell(position, currentPrice);
        if (trade) {
          const p = await executor.getPortfolio();
          const pnl = trade.pnl ?? 0;
          const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
          logEvent('SELL', `${position.side} @ $${currentPrice.toFixed(3)} | ${pnlStr}`, p);
        }
      }
    }
  }
}

const trader = new DockerTraderWithUI();
trader.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
