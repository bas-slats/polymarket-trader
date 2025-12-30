import type { Market, Opportunity, ConfidenceLevel } from '../types/index.js';

interface WhaleTrade {
  assetId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  timestamp: number;
}

interface WhaleActivity {
  assetId: string;
  totalBuyVolume: number;
  totalSellVolume: number;
  netVolume: number;
  tradeCount: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  lastUpdate: number;
}

// Whale detection thresholds
const WHALE_TRADE_MIN_SIZE = 1000; // $1000+ is a whale trade
const WHALE_SIGNAL_MIN_NET_VOLUME = 5000; // $5000 net buying/selling
const WHALE_SIGNAL_MIN_TRADES = 3; // At least 3 whale trades
const LOOKBACK_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export class WhaleTracker {
  private trades: WhaleTrade[] = [];
  private activity: Map<string, WhaleActivity> = new Map();

  recordTrade(trade: WhaleTrade): void {
    // Only track whale-sized trades
    if (trade.size < WHALE_TRADE_MIN_SIZE) return;

    this.trades.push(trade);

    // Update activity aggregation
    let activity = this.activity.get(trade.assetId);
    if (!activity) {
      activity = {
        assetId: trade.assetId,
        totalBuyVolume: 0,
        totalSellVolume: 0,
        netVolume: 0,
        tradeCount: 0,
        avgBuyPrice: 0,
        avgSellPrice: 0,
        lastUpdate: trade.timestamp,
      };
      this.activity.set(trade.assetId, activity);
    }

    if (trade.side === 'BUY') {
      const prevTotal = activity.totalBuyVolume;
      activity.totalBuyVolume += trade.size;
      activity.avgBuyPrice =
        (activity.avgBuyPrice * prevTotal + trade.price * trade.size) / activity.totalBuyVolume;
    } else {
      const prevTotal = activity.totalSellVolume;
      activity.totalSellVolume += trade.size;
      activity.avgSellPrice =
        (activity.avgSellPrice * prevTotal + trade.price * trade.size) / activity.totalSellVolume;
    }

    activity.netVolume = activity.totalBuyVolume - activity.totalSellVolume;
    activity.tradeCount++;
    activity.lastUpdate = trade.timestamp;

    // Clean up old data
    this.cleanup();
  }

  private cleanup(): void {
    const cutoff = Date.now() - LOOKBACK_WINDOW_MS;

    // Remove old trades
    this.trades = this.trades.filter((t) => t.timestamp >= cutoff);

    // Recalculate activity from remaining trades
    this.activity.clear();
    for (const trade of this.trades) {
      let activity = this.activity.get(trade.assetId);
      if (!activity) {
        activity = {
          assetId: trade.assetId,
          totalBuyVolume: 0,
          totalSellVolume: 0,
          netVolume: 0,
          tradeCount: 0,
          avgBuyPrice: 0,
          avgSellPrice: 0,
          lastUpdate: trade.timestamp,
        };
        this.activity.set(trade.assetId, activity);
      }

      if (trade.side === 'BUY') {
        const prevTotal = activity.totalBuyVolume;
        activity.totalBuyVolume += trade.size;
        if (activity.totalBuyVolume > 0) {
          activity.avgBuyPrice =
            (activity.avgBuyPrice * prevTotal + trade.price * trade.size) / activity.totalBuyVolume;
        }
      } else {
        const prevTotal = activity.totalSellVolume;
        activity.totalSellVolume += trade.size;
        if (activity.totalSellVolume > 0) {
          activity.avgSellPrice =
            (activity.avgSellPrice * prevTotal + trade.price * trade.size) / activity.totalSellVolume;
        }
      }

      activity.netVolume = activity.totalBuyVolume - activity.totalSellVolume;
      activity.tradeCount++;
      activity.lastUpdate = Math.max(activity.lastUpdate, trade.timestamp);
    }
  }

  getSignals(markets: Market[]): Opportunity[] {
    const opportunities: Opportunity[] = [];

    for (const market of markets) {
      for (let i = 0; i < market.outcomes.length; i++) {
        const outcome = market.outcomes[i];
        if (!outcome.tokenId) continue;

        const activity = this.activity.get(outcome.tokenId);
        if (!activity) continue;

        // Check for whale signal
        const signal = this.analyzeWhaleActivity(activity, outcome.price);
        if (signal) {
          const side = outcome.name.toLowerCase().includes('yes') ? 'YES' : 'NO';

          opportunities.push({
            market,
            strategy: 'whale',
            side,
            outcomeIndex: i,
            entryPrice: outcome.price,
            estimatedProb: signal.estimatedProb,
            edge: signal.edge,
            confidence: signal.confidence,
            reason: signal.reason,
          });
        }
      }
    }

    // Sort by edge
    return opportunities.sort((a, b) => b.edge - a.edge);
  }

  private analyzeWhaleActivity(
    activity: WhaleActivity,
    currentPrice: number
  ): { estimatedProb: number; edge: number; confidence: ConfidenceLevel; reason: string } | null {
    // Need minimum activity
    if (activity.tradeCount < WHALE_SIGNAL_MIN_TRADES) {
      return null;
    }

    const absNetVolume = Math.abs(activity.netVolume);
    if (absNetVolume < WHALE_SIGNAL_MIN_NET_VOLUME) {
      return null;
    }

    // Determine signal direction
    const isBullish = activity.netVolume > 0;
    const volumeRatio = activity.totalBuyVolume / Math.max(activity.totalSellVolume, 1);

    // Calculate estimated probability based on whale behavior
    // Whales are assumed to have better information
    let estimatedProb: number;
    let reason: string;

    if (isBullish) {
      // Net buying - whales think price should be higher
      const buyPremium = 0.05 + Math.min(0.15, absNetVolume / 50000); // 5-20% premium based on volume
      estimatedProb = Math.min(0.95, currentPrice + buyPremium);
      reason = `Whale net BUY $${(absNetVolume / 1000).toFixed(1)}k (${activity.tradeCount} trades)`;
    } else {
      // Net selling - whales think price should be lower
      // This means the OTHER side is underpriced
      const sellDiscount = 0.05 + Math.min(0.15, absNetVolume / 50000);
      estimatedProb = Math.max(0.05, currentPrice - sellDiscount);
      reason = `Whale net SELL $${(absNetVolume / 1000).toFixed(1)}k (${activity.tradeCount} trades)`;
    }

    const edge = estimatedProb - currentPrice;

    // Only signal if there's meaningful edge
    if (Math.abs(edge) < 0.03) {
      return null;
    }

    // Confidence based on volume and trade count
    let confidence: ConfidenceLevel = 'low';
    if (absNetVolume >= 20000 && activity.tradeCount >= 5) {
      confidence = 'high';
    } else if (absNetVolume >= 10000 || activity.tradeCount >= 4) {
      confidence = 'standard';
    }

    // If whales are selling but we're looking at this outcome, flip the signal
    // We want to follow whale BUYING, or bet against whale SELLING
    if (!isBullish) {
      // Whales selling this outcome means they think it's overpriced
      // The edge is negative for this outcome, but we shouldn't enter
      // Instead, the opposite outcome might be interesting
      return null; // Let the value betting strategy handle contrarian plays
    }

    return {
      estimatedProb,
      edge,
      confidence,
      reason,
    };
  }

  getActivity(assetId: string): WhaleActivity | undefined {
    return this.activity.get(assetId);
  }

  getAllActivity(): WhaleActivity[] {
    return Array.from(this.activity.values());
  }

  getRecentTrades(limit: number = 10): WhaleTrade[] {
    return this.trades.slice(-limit);
  }

  getStats(): { totalTrades: number; totalVolume: number; uniqueAssets: number } {
    const totalVolume = this.trades.reduce((sum, t) => sum + t.size, 0);
    return {
      totalTrades: this.trades.length,
      totalVolume,
      uniqueAssets: this.activity.size,
    };
  }
}

export const whaleTracker = new WhaleTracker();
