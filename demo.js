// Sample data used only when panel.html is opened outside DevTools (UI development).

const URL = 'https://api.example.com/graphql';

function har(body, response, { status = 200, time = 120, method = 'POST', url = URL } = {}) {
  const text = JSON.stringify(response);
  return {
    _resourceType: 'fetch',
    time,
    startedDateTime: new Date().toISOString(),
    request: {
      method,
      url,
      headers: [
        { name: 'content-type', value: 'application/json' },
        { name: 'authorization', value: 'Bearer demo-token' },
      ],
      ...(body ? { postData: { mimeType: 'application/json', text: JSON.stringify(body) } } : {}),
    },
    response: {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: [{ name: 'content-type', value: 'application/json' }],
      bodySize: text.length,
      content: { size: text.length, text },
    },
  };
}

export function demoEntries() {
  return [
    har(
      {
        operationName: 'viewer',
        query: 'query viewer { viewer { id name email avatarUrl roles cart { itemCount } } }',
      },
      {
        data: {
          viewer: {
            id: 'u_1042',
            name: 'Alex Morgan',
            email: 'alex@example.com',
            avatarUrl: null,
            roles: ['CUSTOMER'],
            cart: { itemCount: 2 },
          },
        },
      },
      { time: 64 },
    ),
    har(null, { currency: 'EUR', locale: 'en-GB', features: { wishlist: true, reviews: true } }, {
      method: 'GET',
      url: 'https://api.example.com/v1/config?channel=web',
      time: 38,
    }),
    har(
      {
        operationName: 'products',
        query:
          'query products($first: Int!, $filter: ProductFilter) { products(first: $first, filter: $filter) { totalCount edges { node { id name price { amount currency } ...ProductStock } } pageInfo { hasNextPage endCursor } } } fragment ProductStock on Product { inStock warehouse { code } }',
        variables: { first: 3, filter: { category: 'headphones', inStock: true } },
      },
      {
        data: {
          products: {
            totalCount: 24,
            edges: [
              { node: { id: 'p_1', name: 'Studio Headphones', price: { amount: 129, currency: 'EUR' }, inStock: true, warehouse: { code: 'AMS' } } },
              { node: { id: 'p_2', name: 'Wireless Earbuds', price: { amount: 89, currency: 'EUR' }, inStock: true, warehouse: { code: 'BER' } } },
              { node: { id: 'p_3', name: 'Travel Case', price: { amount: 19.9, currency: 'EUR' }, inStock: true, warehouse: { code: 'AMS' } } },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'Y3Vyc29yOjM=' },
          },
        },
      },
      { time: 182 },
    ),
    har(
      { limit: 4, context: { productId: 'p_1' } },
      { items: [{ id: 'p_7', score: 0.92 }, { id: 'p_9', score: 0.87 }] },
      { url: 'https://api.example.com/v1/recommendations', time: 91 },
    ),
    har(
      {
        operationName: 'addToCart',
        query:
          'mutation addToCart($input: AddToCartInput!) { addToCart(input: $input) { cart { id itemCount total { amount currency } } } }',
        variables: { input: { productId: 'p_1', quantity: 1 } },
      },
      { data: { addToCart: { cart: { id: 'c_88', itemCount: 3, total: { amount: 237.9, currency: 'EUR' } } } } },
      { time: 143 },
    ),
    har(
      {
        operationName: 'applyCoupon',
        query: 'mutation applyCoupon($code: String!) { applyCoupon(code: $code) { cart { id total { amount } } } }',
        variables: { code: 'SUMMER25' },
      },
      { errors: [{ message: 'Coupon has expired', path: ['applyCoupon'], extensions: { code: 'COUPON_EXPIRED' } }], data: null },
      { time: 97 },
    ),
    har(null, { message: 'Not found' }, { method: 'GET', url: 'https://api.example.com/v1/reviews/p_404', status: 404, time: 27 }),
    {
      pending: true,
      type: 'start',
      requestId: 'demo-1',
      url: URL,
      method: 'POST',
      timeStamp: Date.now(),
      body: JSON.stringify({
        operationName: 'checkout',
        query: 'mutation checkout($input: CheckoutInput!) { checkout(input: $input) { order { id status } } }',
        variables: { input: { cartId: 'c_88', paymentMethod: 'CARD' } },
      }),
    },
  ];
}
