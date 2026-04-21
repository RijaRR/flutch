'use strict';

const nodeFetch = require('node-fetch');

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.payload = options.payload;
  }
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    // Certaines erreurs upstream peuvent répondre en HTML ou en texte brut.
    return null;
  }
}

class FlutchApiClient {
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.email = options.email;
    this.password = options.password;
    this.fetchImpl = options.fetchImpl || (global.fetch ? global.fetch.bind(global) : nodeFetch);
    this.logger = options.logger;
    this.token = null;
  }

  async login() {
    if (!this.baseUrl || !this.email || !this.password) {
      throw new Error('Variables FLUTCH_API_URL, FLUTCH_EMAIL et FLUTCH_PASSWORD requises');
    }

    // Le brief impose un login explicite sur /api/login avec email + password.
    const response = await this.fetchImpl(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: this.email,
        password: this.password,
      }),
    });

    const bodyText = await response.text();
    const payload = safeJsonParse(bodyText);

    if (!response.ok || !payload || !payload.success || !payload.token) {
      throw new ApiError('Connexion au Flutch impossible', {
        status: response.status,
        payload,
      });
    }

    this.token = payload.token;
    if (this.logger) {
      this.logger.info('Worker Mickael connecté au Flutch');
    }

    return payload;
  }

  async request(method, path, body, retried = false) {
    if (!this.token) {
      await this.login();
    }

    // Tous les appels métier réutilisent le Bearer token jusqu'au prochain 401.
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401 && !retried) {
      if (this.logger) {
        this.logger.warn(`Token expiré, reconnexion automatique sur ${path}`);
      }
      // Le brief demande une reconnexion automatique quand le token a expiré.
      this.token = null;
      await this.login();
      return this.request(method, path, body, true);
    }

    const bodyText = await response.text();
    const payload = safeJsonParse(bodyText);

    if (!response.ok) {
      throw new ApiError(`Erreur API ${method} ${path}`, {
        status: response.status,
        payload,
      });
    }

    return payload;
  }

  getDashboard() {
    return this.request('GET', '/api/todos/dashboard');
  }

  getAcquereurDetail(acquereurId) {
    return this.request('GET', `/api/acquereurs/${acquereurId}/detail`);
  }

  getBienDetail(bienId) {
    return this.request('GET', `/api/biens/${bienId}/detail`);
  }

  enqueueEmail(acquereurId, bienIds, channel = 'both') {
    return this.request('POST', '/api/email-queue/enqueue', {
      acquereur_id: acquereurId,
      bien_ids: bienIds,
      channel,
    });
  }
}

module.exports = {
  ApiError,
  FlutchApiClient,
};
