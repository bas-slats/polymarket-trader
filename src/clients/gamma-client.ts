import axios, { AxiosInstance } from 'axios';
import Bottleneck from 'bottleneck';
import type { Market, MarketCategory, GammaMarket, Outcome } from '../types/index.js';
import { config } from '../config/index.js';

export class GammaClient {
  private http: AxiosInstance;
  private limiter: Bottleneck;

  constructor() {
    this.http = axios.create({
      baseURL: config.api.gammaHost,
      timeout: 15000,
    });

    // Rate limit: 30 requests per second
    this.limiter = new Bottleneck({
      reservoir: 30,
      reservoirRefreshAmount: 30,
      reservoirRefreshInterval: 1000,
      maxConcurrent: 5,
    });
  }

  async getActiveMarkets(limit: number = 100): Promise<Market[]> {
    return this.limiter.schedule(async () => {
      try {
        const response = await this.http.get('/markets', {
          params: {
            active: true,
            closed: false,
            limit,
            order: 'volume',
            ascending: false,
          },
        });

        const gammaMarkets: GammaMarket[] = response.data;
        return gammaMarkets.map((m) => this.parseMarket(m)).filter((m): m is Market => m !== null);
      } catch (error) {
        console.error('Failed to fetch markets:', error);
        return [];
      }
    });
  }

  async getMarketsByCategory(category: string, limit: number = 50): Promise<Market[]> {
    return this.limiter.schedule(async () => {
      try {
        const response = await this.http.get('/markets', {
          params: {
            active: true,
            closed: false,
            tag_id: category,
            limit,
            order: 'volume',
            ascending: false,
          },
        });

        const gammaMarkets: GammaMarket[] = response.data;
        return gammaMarkets.map((m) => this.parseMarket(m)).filter((m): m is Market => m !== null);
      } catch (error) {
        console.error(`Failed to fetch ${category} markets:`, error);
        return [];
      }
    });
  }

  async getMarket(conditionId: string): Promise<Market | null> {
    return this.limiter.schedule(async () => {
      try {
        const response = await this.http.get(`/markets/${conditionId}`);
        return this.parseMarket(response.data);
      } catch (error) {
        console.error(`Failed to fetch market ${conditionId}:`, error);
        return null;
      }
    });
  }

  async searchMarkets(query: string, limit: number = 20): Promise<Market[]> {
    return this.limiter.schedule(async () => {
      try {
        const response = await this.http.get('/markets', {
          params: {
            active: true,
            closed: false,
            _q: query,
            limit,
          },
        });

        const gammaMarkets: GammaMarket[] = response.data;
        return gammaMarkets.map((m) => this.parseMarket(m)).filter((m): m is Market => m !== null);
      } catch (error) {
        console.error(`Failed to search markets for "${query}":`, error);
        return [];
      }
    });
  }

  private parseMarket(gm: GammaMarket): Market | null {
    try {
      // Parse outcomes
      let outcomeNames: string[] = [];
      let outcomePrices: number[] = [];
      let tokenIds: string[] = [];

      try {
        outcomeNames = JSON.parse(gm.outcomes || '[]');
      } catch {
        outcomeNames = gm.outcomes ? [gm.outcomes] : [];
      }

      try {
        outcomePrices = JSON.parse(gm.outcome_prices || '[]');
      } catch {
        outcomePrices = [];
      }

      // Parse clobTokenIds - this is the key field for WebSocket subscriptions
      try {
        tokenIds = JSON.parse(gm.clobTokenIds || '[]');
      } catch {
        tokenIds = [];
      }

      // Build outcomes from tokens if available
      const outcomes: Outcome[] = (gm.tokens || []).map((token, idx) => ({
        id: token.token_id,
        name: token.outcome || outcomeNames[idx] || `Outcome ${idx}`,
        price: token.price || outcomePrices[idx] || 0,
        tokenId: token.token_id,
      }));

      // If no tokens array but we have clobTokenIds, build outcomes from that
      if (outcomes.length === 0 && tokenIds.length > 0) {
        tokenIds.forEach((tokenId, idx) => {
          outcomes.push({
            id: tokenId,
            name: outcomeNames[idx] || `Outcome ${idx}`,
            price: outcomePrices[idx] || 0,
            tokenId: tokenId,
          });
        });
      }

      // If no tokens at all, use parsed outcomes without tokenIds
      if (outcomes.length === 0 && outcomeNames.length > 0) {
        outcomeNames.forEach((name, idx) => {
          outcomes.push({
            id: `${gm.condition_id}-${idx}`,
            name,
            price: outcomePrices[idx] || 0,
            tokenId: '',
          });
        });
      }

      // Determine category
      const category = this.categorizeMarket(gm);

      return {
        id: gm.id,
        conditionId: gm.condition_id,
        slug: gm.slug,
        question: gm.question,
        category,
        outcomes,
        volume: parseFloat(gm.volume || '0'),
        liquidity: parseFloat(gm.liquidity || '0'),
        endDate: new Date(gm.end_date_iso),
        active: gm.active,
        closed: gm.closed,
      };
    } catch (error) {
      console.error('Failed to parse market:', error);
      return null;
    }
  }

  private categorizeMarket(gm: GammaMarket): MarketCategory {
    const tags = (gm.tags || []).map((t) => t.label.toLowerCase());
    const question = gm.question.toLowerCase();
    const slug = gm.slug.toLowerCase();

    // Politics
    if (
      tags.some((t) => ['politics', 'election', 'government'].includes(t)) ||
      question.includes('president') ||
      question.includes('election') ||
      question.includes('congress') ||
      question.includes('senate') ||
      question.includes('governor')
    ) {
      return 'politics';
    }

    // Sports
    if (
      tags.some((t) => ['sports', 'nfl', 'nba', 'mlb', 'soccer', 'football'].includes(t)) ||
      question.includes('win the') ||
      question.includes('super bowl') ||
      question.includes('championship') ||
      slug.includes('nfl') ||
      slug.includes('nba')
    ) {
      return 'sports';
    }

    // Crypto
    if (
      tags.some((t) => ['crypto', 'bitcoin', 'ethereum', 'cryptocurrency'].includes(t)) ||
      question.includes('bitcoin') ||
      question.includes('btc') ||
      question.includes('ethereum') ||
      question.includes('eth') ||
      question.includes('crypto')
    ) {
      return 'crypto';
    }

    // Entertainment
    if (
      tags.some((t) => ['entertainment', 'movies', 'tv', 'music', 'celebrity'].includes(t)) ||
      question.includes('oscar') ||
      question.includes('grammy') ||
      question.includes('emmy')
    ) {
      return 'entertainment';
    }

    // Science
    if (
      tags.some((t) => ['science', 'technology', 'space', 'ai'].includes(t)) ||
      question.includes('spacex') ||
      question.includes('nasa') ||
      question.includes('ai ')
    ) {
      return 'science';
    }

    // Business
    if (
      tags.some((t) => ['business', 'finance', 'economics', 'markets'].includes(t)) ||
      question.includes('stock') ||
      question.includes('fed') ||
      question.includes('rate')
    ) {
      return 'business';
    }

    return 'other';
  }
}

export const gammaClient = new GammaClient();
