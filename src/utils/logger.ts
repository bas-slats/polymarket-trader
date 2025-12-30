import { createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';

// Ensure logs directory exists
const LOGS_DIR = './logs';
try {
  mkdirSync(LOGS_DIR, { recursive: true });
} catch {}

// Create log file with timestamp
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE = join(LOGS_DIR, `trader-${timestamp}.log`);
const TRADES_FILE = join(LOGS_DIR, `trades-${timestamp}.jsonl`);

// Write streams
const logStream = createWriteStream(LOG_FILE, { flags: 'a' });
const tradesStream = createWriteStream(TRADES_FILE, { flags: 'a' });

export interface TradeLog {
  timestamp: string;
  action: 'BUY' | 'SELL';
  strategy: string;
  market: string;
  side: string;
  price: number;
  size: number;
  pnl?: number;
  reason?: string;
}

export interface ScanLog {
  timestamp: string;
  scanNumber: number;
  marketsScanned: number;
  eligibleMarkets: number;
  arbitrageOpportunities: number;
  valueOpportunities: number;
  whaleSignals: number;
  portfolioValue: number;
  balance: number;
  totalPnl: number;
  openPositions: number;
  final?: boolean;
}

class Logger {
  private scanCount = 0;

  log(level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'SCAN', message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`;

    // Write to file
    logStream.write(logLine);

    // Also write to latest.log for easy access
    // (overwrite mode for this one)
  }

  logTrade(trade: TradeLog): void {
    const timestamp = new Date().toISOString();
    trade.timestamp = timestamp;

    // Write to JSONL file (one JSON object per line)
    tradesStream.write(JSON.stringify(trade) + '\n');

    // Also log to main log
    this.log('TRADE', `${trade.action} ${trade.side} @ $${trade.price.toFixed(3)}`, {
      market: trade.market.slice(0, 50),
      strategy: trade.strategy,
      size: trade.size,
      pnl: trade.pnl,
    });
  }

  logScan(scan: ScanLog): void {
    this.scanCount++;
    scan.scanNumber = this.scanCount;
    scan.timestamp = new Date().toISOString();

    this.log('SCAN', `Scan #${this.scanCount}`, scan);
  }

  logOpportunity(type: string, market: string, details: any): void {
    this.log('INFO', `${type} opportunity: ${market.slice(0, 50)}...`, details);
  }

  logError(message: string, error?: any): void {
    this.log('ERROR', message, error instanceof Error ? { message: error.message, stack: error.stack } : error);
  }

  getLogFile(): string {
    return LOG_FILE;
  }

  getTradesFile(): string {
    return TRADES_FILE;
  }

  close(): void {
    logStream.end();
    tradesStream.end();
  }
}

export const logger = new Logger();

// Log startup
logger.log('INFO', 'Paper trading system started', {
  logFile: LOG_FILE,
  tradesFile: TRADES_FILE,
});
