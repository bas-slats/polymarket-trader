import blessed from 'blessed';
import contrib from 'blessed-contrib';

interface PortfolioData {
  balance: number;
  totalValue: number;
  totalPnl: number;
  totalPnlPercent: number;
  drawdownPercent: number;
  openPositions: {
    marketQuestion: string;
    side: string;
    entryPrice: number;
    currentPrice: number;
    pnl: number;
    strategy: string;
  }[];
}

interface StatsData {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
}

interface AllocationData {
  strategy: string;
  currentWeight: number;
}

interface RTStats {
  priceDropTrades: number;
  whaleFollowTrades: number;
  arbTrades: number;
  instantExits: number;
}

export class Dashboard {
  private screen: blessed.Widgets.Screen;
  private grid: any;

  // Widgets
  private headerBox: blessed.Widgets.BoxElement;
  private statsBox: blessed.Widgets.BoxElement;
  private allocBox: blessed.Widgets.BoxElement;
  private positionsTable: any;
  private activityLog: any;
  private liveEventsLog: any;
  private pnlChart: any;
  private rtStatsBox: blessed.Widgets.BoxElement;

  // Data
  private pnlHistory: number[] = [];
  private startTime: Date;
  private scanCount = 0;
  private wsConnected = false;
  private priceUpdates = 0;
  private tradesSeen = 0;
  private marketsLoaded = 0;
  private eligibleMarkets = 0;

  // Rate limiting for live events
  private lastEventTime = 0;
  private eventBuffer: string[] = [];
  private eventFlushInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startTime = new Date();

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Polymarket Paper Trader',
      fullUnicode: true,
    });

    // Create grid layout (12x12)
    this.grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen });

    // Header - top row
    this.headerBox = this.grid.set(0, 0, 1, 12, blessed.box, {
      content: this.getHeader(),
      tags: true,
      style: {
        fg: 'white',
        bg: 'blue',
      },
    });

    // Stats box - left side
    this.statsBox = this.grid.set(1, 0, 3, 3, blessed.box, {
      label: ' Portfolio ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'cyan' },
        label: { fg: 'cyan' },
      },
    });

    // Allocations box - middle left
    this.allocBox = this.grid.set(1, 3, 3, 3, blessed.box, {
      label: ' Allocations ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'yellow' },
        label: { fg: 'yellow' },
      },
    });

    // Real-time stats - middle
    this.rtStatsBox = this.grid.set(1, 6, 3, 3, blessed.box, {
      label: ' RT Trading ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'magenta' },
        label: { fg: 'magenta' },
      },
    });

    // Live WebSocket events - right side
    this.liveEventsLog = this.grid.set(1, 9, 3, 3, contrib.log, {
      label: ' Live Events ',
      fg: 'cyan',
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: 'cyan' },
      },
      bufferLength: 50,
    });

    // P&L Chart - middle left
    this.pnlChart = this.grid.set(4, 0, 3, 6, contrib.line, {
      label: ' P&L History ',
      showLegend: false,
      style: {
        line: 'green',
        text: 'white',
        baseline: 'white',
        border: { fg: 'green' },
      },
    });

    // Positions table - middle right
    this.positionsTable = this.grid.set(4, 6, 3, 6, contrib.table, {
      label: ' Open Positions ',
      keys: true,
      fg: 'white',
      columnSpacing: 1,
      columnWidth: [26, 4, 6, 6, 8, 7],
      style: {
        border: { fg: 'cyan' },
        header: { fg: 'cyan', bold: true },
        cell: { fg: 'white' },
      },
    });

    // Activity log - bottom left
    this.activityLog = this.grid.set(7, 0, 5, 12, contrib.log, {
      label: ' Activity Log ',
      fg: 'green',
      selectedFg: 'green',
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: 'green' },
      },
      bufferLength: 100,
    });

    // Key bindings
    this.screen.key(['escape', 'q', 'C-c'], () => {
      return process.exit(0);
    });

    // Start event flush interval
    this.eventFlushInterval = setInterval(() => {
      this.flushEvents();
    }, 100);

    // Initial render
    this.screen.render();
  }

  private getHeader(): string {
    const uptime = this.getUptime();
    const wsStatus = this.wsConnected ? '{green-fg}WS:ON{/}' : '{red-fg}WS:OFF{/}';
    return ` POLYMARKET PAPER TRADER v3.0 | ${wsStatus} | Uptime: ${uptime} | Scan #${this.scanCount} | Markets: ${this.marketsLoaded} | Q=Quit `;
  }

  private getUptime(): string {
    const diff = Date.now() - this.startTime.getTime();
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  updateHeader(): void {
    this.headerBox.setContent(this.getHeader());
  }

  updatePortfolio(portfolio: PortfolioData, stats: StatsData): void {
    const pnlColor = portfolio.totalPnl >= 0 ? 'green' : 'red';
    const pnlSign = portfolio.totalPnl >= 0 ? '+' : '';
    const ddColor = portfolio.drawdownPercent > 10 ? 'red' : 'green';

    const content = [
      `{white-fg}Bal:{/} {yellow-fg}$${portfolio.balance.toFixed(0)}{/}`,
      `{white-fg}Val:{/} {yellow-fg}$${portfolio.totalValue.toFixed(0)}{/}`,
      `{white-fg}P&L:{/} {${pnlColor}-fg}${pnlSign}$${portfolio.totalPnl.toFixed(2)}{/}`,
      `     {${pnlColor}-fg}(${pnlSign}${portfolio.totalPnlPercent.toFixed(1)}%){/}`,
      `{white-fg}DD:{/}  {${ddColor}-fg}${portfolio.drawdownPercent.toFixed(1)}%{/}`,
      ``,
      `{white-fg}Trades:{/} {cyan-fg}${stats.totalTrades}{/}`,
      `{white-fg}WinR:{/}   {cyan-fg}${(stats.winRate * 100).toFixed(0)}%{/}`,
    ].join('\n');

    this.statsBox.setContent(content);

    // Update P&L history
    this.pnlHistory.push(portfolio.totalPnl);
    if (this.pnlHistory.length > 60) {
      this.pnlHistory = this.pnlHistory.slice(-60);
    }

    // Update chart
    const chartData = {
      title: 'P&L',
      x: this.pnlHistory.map((_, i) => i.toString()),
      y: this.pnlHistory,
      style: { line: portfolio.totalPnl >= 0 ? 'green' : 'red' },
    };
    this.pnlChart.setData([chartData]);

    // Update positions table
    const posData = portfolio.openPositions.slice(0, 6).map((pos) => {
      const pnlStr = pos.pnl >= 0 ? `+${pos.pnl.toFixed(2)}` : `${pos.pnl.toFixed(2)}`;
      return [
        pos.marketQuestion.slice(0, 24) + '..',
        pos.side,
        pos.entryPrice.toFixed(2),
        pos.currentPrice.toFixed(2),
        pnlStr,
        pos.strategy.slice(0, 6),
      ];
    });

    this.positionsTable.setData({
      headers: ['Market', 'Side', 'Entry', 'Curr', 'P&L', 'Strat'],
      data: posData.length > 0 ? posData : [['No positions', '', '', '', '', '']],
    });
  }

  updateAllocations(allocations: AllocationData[]): void {
    const content = allocations
      .map((a) => {
        const pct = (a.currentWeight * 100).toFixed(0);
        const bar = this.getProgressBar(a.currentWeight, 8);
        return `{white-fg}${a.strategy.slice(0, 6).padEnd(7)}{/}${bar}{cyan-fg}${pct.padStart(3)}%{/}`;
      })
      .join('\n');

    this.allocBox.setContent(content);
  }

  updateRTStats(rtStats: RTStats): void {
    const total = rtStats.priceDropTrades + rtStats.whaleFollowTrades + rtStats.arbTrades;

    const content = [
      `{white-fg}Drops:{/} {green-fg}${rtStats.priceDropTrades}{/}`,
      `{white-fg}Whale:{/} {magenta-fg}${rtStats.whaleFollowTrades}{/}`,
      `{white-fg}Arb:{/}   {yellow-fg}${rtStats.arbTrades}{/}`,
      `{white-fg}Exit:{/}  {cyan-fg}${rtStats.instantExits}{/}`,
      ``,
      `{white-fg}Total:{/} {bold}${total}{/}`,
      ``,
      `{gray-fg}${this.priceUpdates} upd{/}`,
    ].join('\n');

    this.rtStatsBox.setContent(content);
  }

  updateScanInfo(scanCount: number, marketsLoaded: number, eligible: number): void {
    this.scanCount = scanCount;
    this.marketsLoaded = marketsLoaded;
    this.eligibleMarkets = eligible;
    this.updateHeader();
  }

  updateWebSocketStats(connected: boolean, priceUpdates: number, tradesSeen: number): void {
    this.wsConnected = connected;
    this.priceUpdates = priceUpdates;
    this.tradesSeen = tradesSeen;
  }

  // Live WebSocket event logging
  logLiveEvent(type: 'price' | 'trade' | 'whale', message: string): void {
    const now = Date.now();

    // Rate limit: max 10 events per second
    if (now - this.lastEventTime < 100) {
      // Buffer the event
      if (this.eventBuffer.length < 20) {
        this.eventBuffer.push(this.formatLiveEvent(type, message));
      }
      return;
    }

    this.lastEventTime = now;
    this.liveEventsLog.log(this.formatLiveEvent(type, message));
  }

  private formatLiveEvent(type: 'price' | 'trade' | 'whale', message: string): string {
    const colors: Record<string, string> = {
      price: 'gray',
      trade: 'cyan',
      whale: 'magenta',
    };
    const icons: Record<string, string> = {
      price: '↕',
      trade: '◆',
      whale: '🐋',
    };
    return `{${colors[type]}-fg}${icons[type]}{/} ${message.slice(0, 25)}`;
  }

  private flushEvents(): void {
    if (this.eventBuffer.length === 0) return;

    // Show aggregated count if many events
    if (this.eventBuffer.length > 5) {
      this.liveEventsLog.log(`{gray-fg}... ${this.eventBuffer.length} events{/}`);
    } else {
      for (const event of this.eventBuffer) {
        this.liveEventsLog.log(event);
      }
    }
    this.eventBuffer = [];
  }

  logPriceUpdate(assetId: string, price: number, change?: number): void {
    const changeStr = change !== undefined
      ? (change >= 0 ? `{green-fg}+${(change * 100).toFixed(1)}%{/}` : `{red-fg}${(change * 100).toFixed(1)}%{/}`)
      : '';
    this.logLiveEvent('price', `${assetId.slice(0, 8)}.. $${price.toFixed(3)} ${changeStr}`);
  }

  logLiveTrade(assetId: string, side: string, price: number, size: number): void {
    const sideColor = side === 'BUY' ? 'green' : 'red';
    const sizeStr = size >= 1000 ? `$${(size / 1000).toFixed(1)}k` : `$${size.toFixed(0)}`;
    this.logLiveEvent(
      size >= 5000 ? 'whale' : 'trade',
      `{${sideColor}-fg}${side}{/} ${sizeStr} @${price.toFixed(2)}`
    );
  }

  log(message: string, type: 'info' | 'success' | 'warning' | 'error' | 'trade' = 'info'): void {
    const time = new Date().toLocaleTimeString();
    let prefix = '';

    switch (type) {
      case 'success':
        prefix = '{green-fg}✓{/}';
        break;
      case 'warning':
        prefix = '{yellow-fg}⚠{/}';
        break;
      case 'error':
        prefix = '{red-fg}✗{/}';
        break;
      case 'trade':
        prefix = '{cyan-fg}${/}';
        break;
      default:
        prefix = '{gray-fg}→{/}';
    }

    this.activityLog.log(`{gray-fg}${time}{/} ${prefix} ${message}`);
  }

  logTrade(action: string, market: string, side: string, price: number, size: number, pnl?: number): void {
    const actionColor = action === 'BUY' ? 'green' : 'red';
    const pnlStr = pnl !== undefined ? (pnl >= 0 ? `{green-fg}+$${pnl.toFixed(2)}{/}` : `{red-fg}-$${Math.abs(pnl).toFixed(2)}{/}`) : '';

    this.log(
      `{${actionColor}-fg}${action}{/} ${side} {white-fg}${market.slice(0, 35)}{/} @ {yellow-fg}$${price.toFixed(3)}{/} x${size.toFixed(0)} ${pnlStr}`,
      'trade'
    );
  }

  logOpportunity(type: string, market: string, details: string): void {
    const typeColors: Record<string, string> = {
      ARBITRAGE: 'yellow',
      VALUE: 'blue',
      WHALE: 'magenta',
      RT_PRICE_DROP: 'green',
      RT_WHALE: 'magenta',
      RT_ARB: 'yellow',
    };
    const color = typeColors[type] || 'white';
    this.log(`{${color}-fg}[${type}]{/} ${market.slice(0, 40)}.. ${details}`, 'info');
  }

  private getProgressBar(value: number, width: number): string {
    const filled = Math.round(value * width);
    const empty = width - filled;
    return `{green-fg}${'█'.repeat(filled)}{/}{gray-fg}${'░'.repeat(empty)}{/}`;
  }

  render(): void {
    this.updateHeader();
    this.screen.render();
  }

  destroy(): void {
    if (this.eventFlushInterval) {
      clearInterval(this.eventFlushInterval);
    }
    this.screen.destroy();
  }
}

export const dashboard = new Dashboard();
