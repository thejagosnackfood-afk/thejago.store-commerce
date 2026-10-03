const { parseOrderListDto, parseOrderSearchDto, RequestValidationError } = require('../dto/order.dto.cjs');

async function fetchOrders(req, res, dependencies, parseDto) {
  const context = await dependencies.createContext(req, res);
  const { config, sdk, token, tokenSource } = context;
  if (!token || typeof token.access_token !== 'string' || !token.access_token ||
      typeof token.refresh_token !== 'string' || !token.refresh_token) {
    throw new RequestValidationError('Sesi Shopee tidak tersedia. Hubungkan ulang akun.', 401);
  }
  const dto = parseDto(req);
  const data = await dependencies.sdkCall(config, token, () => sdk.order.getOrderList({
    time_range_field: 'create_time',
    ...dto,
  }));
  return {
    tokenSource,
    shopId: token.shop_id ?? null,
    query: {
      time_from: dto.time_from,
      time_to: dto.time_to,
      page_size: dto.page_size,
      cursor: dto.cursor || null,
      order_status: dto.order_status || null,
    },
    data,
  };
}

function listOrders(req, res, dependencies) {
  return fetchOrders(req, res, dependencies, parseOrderListDto);
}

function searchOrders(req, res, dependencies) {
  return fetchOrders(req, res, dependencies, parseOrderSearchDto);
}

module.exports = { listOrders, searchOrders };
