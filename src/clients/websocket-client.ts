import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Market, Outcome } from '../types/index.js';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export interface PriceUpdate {
  assetId: string;
  price: number;
  timestamp: number;
}

export interface OrderBookUpdate {
  assetId: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  timestamp: number;
}

export interface TradeUpdate {
  assetId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  timestamp: number;
}

export class PolymarketWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedTokens: Set<string> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private pingInterval: NodeJS.Timeout | null = null;
  private isConnected = false;

  // Price cache for quick lookups
  private priceCache: Map<string, number> = new Map();

  constructor() {
    super();
    // Prevent unhandled error crashes
    this.on('error', () => {});
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(CLOB_WS_URL);

        this.ws.on('open', () => {
          // Connected - dashboard will show status
          this.isConnected = true;
          this.reconnectAttempts = 0;

          // Start ping interval
          this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.ping();
            }
          }, 30000);

          // Resubscribe to any tokens we were tracking
          if (this.subscribedTokens.size > 0) {
            this.subscribeToAssets(Array.from(this.subscribedTokens));
          }

          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch {
            // Silently ignore non-JSON messages (heartbeats, etc.)
          }
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          this.cleanup();
          this.attemptReconnect();
        });

        this.ws.on('error', (error) => {
          this.emit('error', error);
          if (!this.isConnected) {
            reject(error);
          }
        });

        this.ws.on('pong', () => {
          // Connection is alive
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(message: any): void {
    // Handle different message types from Polymarket WebSocket
    // The exact format depends on the subscription

    if (Array.isArray(message)) {
      // Batch of updates
      for (const update of message) {
        this.processUpdate(update);
      }
    } else {
      this.processUpdate(message);
    }
  }

  private processUpdate(update: any): void {
    const eventType = update.event_type || update.type;

    // Handle orderbook updates (most common format from Polymarket)
    if (update.bids !== undefined || update.asks !== undefined) {
      this.handleOrderBook(update);
      return;
    }

    switch (eventType) {
      case 'price_change':
      case 'last_trade_price':
        this.handlePriceChange(update);
        break;

      case 'book':
      case 'orderbook':
        this.handleOrderBook(update);
        break;

      case 'trade':
      case 'tick':
        this.handleTrade(update);
        break;

      default:
        // Handle unknown message types - try to extract price data anyway
        if (update.asset_id || update.market || update.token_id) {
          // Try to emit as price update if it has price-like data
          if (update.price || update.last_price || update.best_bid || update.best_ask) {
            this.handlePriceChange(update);
          }
          this.emit('update', update);
        }
    }
  }

  private handlePriceChange(update: any): void {
    const assetId = update.asset_id || update.token_id;
    const price = parseFloat(update.price || update.last_price || 0);

    if (assetId && price > 0) {
      this.priceCache.set(assetId, price);

      const priceUpdate: PriceUpdate = {
        assetId,
        price,
        timestamp: update.timestamp || Date.now(),
      };

      this.emit('price', priceUpdate);
    }
  }

  private handleOrderBook(update: any): void {
    const assetId = update.asset_id || update.token_id;

    if (!assetId) return;

    const orderBookUpdate: OrderBookUpdate = {
      assetId,
      bids: (update.bids || []).map((b: any) => ({
        price: parseFloat(b.price || b[0]),
        size: parseFloat(b.size || b[1]),
      })),
      asks: (update.asks || []).map((a: any) => ({
        price: parseFloat(a.price || a[0]),
        size: parseFloat(a.size || a[1]),
      })),
      timestamp: parseInt(update.timestamp) || Date.now(),
    };

    // Update price cache with best bid/ask midpoint and emit price event
    if (orderBookUpdate.bids.length > 0 && orderBookUpdate.asks.length > 0) {
      const bestBid = orderBookUpdate.bids[0].price;
      const bestAsk = orderBookUpdate.asks[0].price;
      const midPrice = (bestBid + bestAsk) / 2;

      this.priceCache.set(assetId, midPrice);

      // Emit price update so dashboard can show it
      const priceUpdate: PriceUpdate = {
        assetId,
        price: midPrice,
        timestamp: orderBookUpdate.timestamp,
      };
      this.emit('price', priceUpdate);
    }

    this.emit('orderbook', orderBookUpdate);
  }

  private handleTrade(update: any): void {
    const assetId = update.asset_id || update.token_id;
    const price = parseFloat(update.price || 0);
    const size = parseFloat(update.size || update.amount || 0);

    if (assetId && price > 0) {
      this.priceCache.set(assetId, price);

      const tradeUpdate: TradeUpdate = {
        assetId,
        price,
        size,
        side: update.side?.toUpperCase() || 'BUY',
        timestamp: update.timestamp || Date.now(),
      };

      this.emit('trade', tradeUpdate);
    }
  }

  subscribeToAssets(assetIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Save for when we reconnect
      assetIds.forEach((id) => this.subscribedTokens.add(id));
      return;
    }

    // Add to tracked set
    assetIds.forEach((id) => this.subscribedTokens.add(id));

    // Subscribe message format for Polymarket CLOB WebSocket
    // The market channel subscription format
    const subscribeMessage = {
      assets_ids: assetIds,
      type: 'market',
    };

    this.ws.send(JSON.stringify(subscribeMessage));
  }

  subscribeToMarket(market: Market): void {
    const assetIds = market.outcomes
      .filter((o) => o.tokenId)
      .map((o) => o.tokenId);

    if (assetIds.length > 0) {
      this.subscribeToAssets(assetIds);
    }
  }

  subscribeToMarkets(markets: Market[]): void {
    const assetIds: string[] = [];

    for (const market of markets) {
      for (const outcome of market.outcomes) {
        if (outcome.tokenId) {
          assetIds.push(outcome.tokenId);
        }
      }
    }

    if (assetIds.length > 0) {
      this.subscribeToAssets(assetIds);
    }
  }

  unsubscribeFromAssets(assetIds: string[]): void {
    assetIds.forEach((id) => {
      this.subscribedTokens.delete(id);
      this.priceCache.delete(id);
    });

    if (this.ws?.readyState === WebSocket.OPEN) {
      const unsubscribeMessage = {
        type: 'unsubscribe',
        channel: 'market',
        assets_ids: assetIds,
      };
      this.ws.send(JSON.stringify(unsubscribeMessage));
    }
  }

  getPrice(assetId: string): number | null {
    return this.priceCache.get(assetId) ?? null;
  }

  getAllPrices(): Map<string, number> {
    return new Map(this.priceCache);
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('fatal_disconnect');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    setTimeout(() => {
      this.connect().catch((error) => {
        this.emit('error', error);
      });
    }, delay);
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect(): void {
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedTokens.clear();
    this.priceCache.clear();
    this.isConnected = false;
  }

  isActive(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  getSubscribedCount(): number {
    return this.subscribedTokens.size;
  }
}

export const polymarketWS = new PolymarketWebSocket();
