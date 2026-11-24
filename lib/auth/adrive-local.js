// lib/auth/adrive-local.js —— 兼容层：本机登录态导入的实现已移到 drive-login-state.js
export {
  AUTH_BASE,
  ADOPT_CLIENT_ID,
  WEB_CLIENT_ID,
  storeRoots,
  harvestRefreshTokens,
  exchangeViaAuth,
  exchangeViaWeb,
  exchangeAnyEndpoint,
  adoptLocalClient,
  importRefreshToken,
} from "./drive-login-state.js";

import { exchangeViaAuth } from "./drive-login-state.js";

/** 旧名保留：用客户端令牌走 auth 端点换新令牌 */