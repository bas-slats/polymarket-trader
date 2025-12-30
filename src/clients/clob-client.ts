import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { config } from '../config/index.js';

// EIP-712 Domain for Polymarket CLOB
const CLOB_DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: 137, // Polygon
};

// EIP-712 Types for CLOB authentication
const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

// Order types for CLOB
export interface ClobOrder {
  tokenId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  type: 'GTC' | 'FOK' | 'GTD'; // Good Till Cancel, Fill or Kill, Good Till Date
  expiration?: number;
}

export interface ClobOrderResponse {
  orderId: string;
  status: 'LIVE' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'PARTIAL';
  filledAmount: number;
  remainingAmount: number;
  avgFillPrice: number;
  timestamp: number;
}

export interface ClobOrderBook {
  tokenId: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  timestamp: number;
}

export interface ClobPosition {
  tokenId: string;
  size: number;
  avgPrice: number;
  side: 'YES' | 'NO';
}

export class ClobClient {
  private client: AxiosInstance;
  private wallet: ethers.Wallet | null = null;
  private address: string | null = null;
  private apiKey: string | null = null;
  private apiSecret: string | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: config.api.clobHost,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // Initialize with credentials
  async initialize(privateKey: string, address: string): Promise<boolean> {
    try {
      this.wallet = new ethers.Wallet(privateKey);
      this.address = address;

      // Verify the private key matches the address
      const derivedAddress = this.wallet.address.toLowerCase();
      if (derivedAddress !== address.toLowerCase()) {
        throw new Error(`Private key does not match address. Expected ${address}, got ${derivedAddress}`);
      }

      // Get API credentials from CLOB
      await this.deriveApiCredentials();

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to initialize CLOB client: ${message}`);
    }
  }

  // Derive API credentials using L1 authentication
  private async deriveApiCredentials(): Promise<void> {
    if (!this.wallet || !this.address) {
      throw new Error('Wallet not initialized');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = 0;
    const message = 'This message attests that I control the given wallet';

    const signature = await this.wallet._signTypedData(
      CLOB_DOMAIN,
      CLOB_AUTH_TYPES,
      {
        address: this.address,
        timestamp,
        nonce,
        message,
      }
    );

    const response = await this.client.post('/auth/derive-api-key', {
      address: this.address,
      timestamp,
      nonce,
      message,
      signature,
    });

    this.apiKey = response.data.apiKey;
    this.apiSecret = response.data.secret;
  }

  // Generate L2 headers for authenticated requests
  private async getAuthHeaders(): Promise<Record<string, string>> {
    if (!this.apiKey || !this.apiSecret || !this.address) {
      throw new Error('API credentials not initialized. Call initialize() first.');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = Math.floor(Math.random() * 1000000);

    // Create HMAC signature for L2 auth
    const message = `${timestamp}${nonce}`;
    const hmac = ethers.utils.computeHmac(
      ethers.utils.SupportedAlgorithm.sha256,
      ethers.utils.toUtf8Bytes(this.apiSecret),
      ethers.utils.toUtf8Bytes(message)
    );

    return {
      'POLY_ADDRESS': this.address,
      'POLY_TIMESTAMP': timestamp,
      'POLY_NONCE': nonce.toString(),
      'POLY_API_KEY': this.apiKey,
      'POLY_SIGNATURE': hmac,
    };
  }

  // Check if client is authenticated
  isAuthenticated(): boolean {
    return this.apiKey !== null && this.apiSecret !== null;
  }

  // Get order book for a token
  async getOrderBook(tokenId: string): Promise<ClobOrderBook> {
    const response = await this.client.get(`/book`, {
      params: { token_id: tokenId },
    });

    return {
      tokenId,
      bids: (response.data.bids || []).map((b: any) => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      })),
      asks: (response.data.asks || []).map((a: any) => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      })),
      timestamp: Date.now(),
    };
  }

  // Get mid price from order book
  async getMidPrice(tokenId: string): Promise<number> {
    const book = await this.getOrderBook(tokenId);

    const bestBid = book.bids[0]?.price || 0;
    const bestAsk = book.asks[0]?.price || 1;

    if (bestBid === 0 && bestAsk === 1) {
      throw new Error('No liquidity in order book');
    }

    return (bestBid + bestAsk) / 2;
  }

  // Place a limit order
  async placeLimitOrder(order: ClobOrder): Promise<ClobOrderResponse> {
    if (!this.isAuthenticated()) {
      throw new Error('Client not authenticated. Call initialize() first.');
    }

    const headers = await this.getAuthHeaders();

    const orderPayload = {
      tokenID: order.tokenId,
      price: order.price.toString(),
      size: order.size.toString(),
      side: order.side,
      orderType: order.type,
      expiration: order.expiration,
    };

    const response = await this.client.post('/order', orderPayload, { headers });

    return {
      orderId: response.data.orderID || response.data.id,
      status: response.data.status || 'LIVE',
      filledAmount: parseFloat(response.data.filledAmount || '0'),
      remainingAmount: parseFloat(response.data.remainingAmount || order.size.toString()),
      avgFillPrice: parseFloat(response.data.avgFillPrice || order.price.toString()),
      timestamp: Date.now(),
    };
  }

  // Place a market order (FOK at best available price)
  async placeMarketOrder(
    tokenId: string,
    side: 'BUY' | 'SELL',
    size: number
  ): Promise<ClobOrderResponse> {
    // Get current order book to determine price
    const book = await this.getOrderBook(tokenId);

    let price: number;
    if (side === 'BUY') {
      // Buy at best ask + slippage
      const bestAsk = book.asks[0]?.price;
      if (!bestAsk) throw new Error('No asks available');
      price = Math.min(0.99, bestAsk + 0.01); // 1% slippage tolerance
    } else {
      // Sell at best bid - slippage
      const bestBid = book.bids[0]?.price;
      if (!bestBid) throw new Error('No bids available');
      price = Math.max(0.01, bestBid - 0.01); // 1% slippage tolerance
    }

    return this.placeLimitOrder({
      tokenId,
      price,
      size,
      side,
      type: 'FOK', // Fill or Kill for market orders
    });
  }

  // Cancel an order
  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.isAuthenticated()) {
      throw new Error('Client not authenticated');
    }

    const headers = await this.getAuthHeaders();

    try {
      await this.client.delete(`/order/${orderId}`, { headers });
      return true;
    } catch {
      return false;
    }
  }

  // Get open orders
  async getOpenOrders(): Promise<ClobOrderResponse[]> {
    if (!this.isAuthenticated()) {
      throw new Error('Client not authenticated');
    }

    const headers = await this.getAuthHeaders();

    const response = await this.client.get('/orders', {
      headers,
      params: { status: 'LIVE' },
    });

    return (response.data || []).map((o: any) => ({
      orderId: o.orderID || o.id,
      status: o.status,
      filledAmount: parseFloat(o.filledAmount || '0'),
      remainingAmount: parseFloat(o.remainingAmount || '0'),
      avgFillPrice: parseFloat(o.avgFillPrice || '0'),
      timestamp: new Date(o.timestamp || o.createdAt).getTime(),
    }));
  }

  // Get positions (balances)
  async getPositions(): Promise<ClobPosition[]> {
    if (!this.isAuthenticated()) {
      throw new Error('Client not authenticated');
    }

    const headers = await this.getAuthHeaders();

    const response = await this.client.get('/positions', { headers });

    return (response.data || []).map((p: any) => ({
      tokenId: p.asset || p.tokenId,
      size: parseFloat(p.size || p.balance || '0'),
      avgPrice: parseFloat(p.avgPrice || '0'),
      side: p.outcome || 'YES',
    }));
  }

  // Get USDC balance
  async getBalance(): Promise<number> {
    if (!this.isAuthenticated()) {
      throw new Error('Client not authenticated');
    }

    const headers = await this.getAuthHeaders();

    const response = await this.client.get('/balance', { headers });

    return parseFloat(response.data.balance || response.data.available || '0');
  }

  // Get trade history
  async getTradeHistory(limit = 100): Promise<any[]> {
    if (!this.isAuthenticated()) {
      throw new Error('Client not authenticated');
    }

    const headers = await this.getAuthHeaders();

    const response = await this.client.get('/trades', {
      headers,
      params: { limit },
    });

    return response.data || [];
  }
}

export const clobClient = new ClobClient();
