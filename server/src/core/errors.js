'use strict';

/**
 * Erros de API padronizados.
 * O tratador global (errorHandler) converte ApiError em resposta JSON segura,
 * sem expor stack trace nem detalhes internos.
 */

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, 'VALIDATION_ERROR', message, details);
const unauthorized = (message = 'Sessão inválida ou expirada. Faça login novamente.') =>
  new ApiError(401, 'UNAUTHENTICATED', message);
const forbidden = (message = 'Você não tem permissão para realizar esta ação.') =>
  new ApiError(403, 'FORBIDDEN', message);
const notFound = (message = 'Registro não encontrado.') => new ApiError(404, 'NOT_FOUND', message);
const conflict = (message) => new ApiError(409, 'CONFLICT', message);
const tooMany = (message = 'Muitas tentativas. Aguarde alguns minutos e tente novamente.') =>
  new ApiError(429, 'RATE_LIMITED', message);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany };
