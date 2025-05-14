import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3000;

// ✅ CORS 设置：允许多个店铺域名
const allowedOrigins = [
  'https://frizzlife-solution.myshopify.com',
  'https://your-other-store.myshopify.com' // 可继续添加
];
app.use(bodyParser.json());
app.use(cors());

app.options('*', (req, res) => {
  res.sendStatus(204);
});

// ✅ 添加：允许嵌入到 Shopify 后台 iframe 中
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors https://admin.shopify.com https://*.myshopify.com;");
  next();
});

function getWarrantyInfo(purchaseDateStr) {
  let purchaseDate;

  // 尝试解析 dd/MM/yyyy 格式
  const ddMmYyyyRegex = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  const match = purchaseDateStr.match(ddMmYyyyRegex);
  if (match) {
    const [, day, month, year] = match;
    purchaseDate = new Date(`${year}-${month}-${day}`);
  } else {
    // 默认使用标准 Date 解析
    purchaseDate = new Date(purchaseDateStr);
  }

  if (isNaN(purchaseDate)) {
    throw new Error('无效的购买日期格式');
  }

  const endDate = new Date(purchaseDate);
  endDate.setMonth(endDate.getMonth() + 18);

  return {
    end_date: endDate.toISOString().split('T')[0],
  };
}

app.post('/proxy', async (req, res) => {
  console.log('🔍 接收到的 req.body:', req.body);
  const { customerId, newWarranty } = req.body;

  try {
    const warrantyInfo = getWarrantyInfo(newWarranty.purchase_date);
    const warrantyWithState = { ...newWarranty, ...warrantyInfo };

    const oldDataRes = await axios.get(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2023-10/customers/${customerId}/metafields.json`,
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN
        }
      }
    );

    const existingMetafield = oldDataRes.data.metafields.find(m => m.namespace === 'custom' && m.key === 'shopify_warranty');
    const oldList = existingMetafield ? JSON.parse(existingMetafield.value) : [];
    const updatedList = [
      ...oldList.filter(item => item.order_id !== warrantyWithState.order_id),
      warrantyWithState
    ];

    const metafieldPayload = {
      namespace: 'custom',
      key: 'shopify_warranty',
      type: 'json',
      value: JSON.stringify(updatedList),
      owner_id: customerId,
      owner_resource: 'customer'
    };

    const metafieldEndpoint = existingMetafield
      ? `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2023-10/metafields/${existingMetafield.id}.json`
      : `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2023-10/metafields.json`;

    const response = await axios({
      method: existingMetafield ? 'put' : 'post',
      url: metafieldEndpoint,
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      data: existingMetafield
        ? { metafield: { ...metafieldPayload, id: existingMetafield.id } }
        : { metafield: metafieldPayload }
    });

    res.json({ success: true, metafield: response.data.metafield });
  } catch (error) {
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});
app.post('/delete', async (req, res) => {
  console.log('🗑️ 删除请求 req.body:', req.body);
  const { customerId, order_id } = req.body;

  if (!customerId || !order_id) {
    return res.status(400).json({ success: false, error: 'customerId 和 order_id 是必填字段' });
  }

  try {
    const oldDataRes = await axios.get(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2023-10/customers/${customerId}/metafields.json`,
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN
        }
      }
    );

    const existingMetafield = oldDataRes.data.metafields.find(m => m.namespace === 'custom' && m.key === 'shopify_warranty');
    if (!existingMetafield) {
      return res.status(404).json({ success: false, error: '未找到保修信息' });
    }

    const oldList = JSON.parse(existingMetafield.value);
    const updatedList = oldList.filter(item => item.order_id !== order_id);

    const metafieldPayload = {
      namespace: 'custom',
      key: 'shopify_warranty',
      type: 'json',
      value: JSON.stringify(updatedList),
      owner_id: customerId,
      owner_resource: 'customer',
      id: existingMetafield.id
    };

    const response = await axios.put(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2023-10/metafields/${existingMetafield.id}.json`,
      { metafield: metafieldPayload },
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ success: true, metafield: response.data.metafield });
  } catch (error) {
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});
// ✅ 修改主页为嵌入式页面
app.get('/', (req, res) => {
  const { shop = '', host = '' } = req.query;

  res.send(`
    <!DOCTYPE html>
    <html lang="zh">
      <head>
        <meta charset="UTF-8" />
        <title>Warranty App</title>
        <script src="https://unpkg.com/@shopify/app-bridge@3"></script>
        <script>
          document.addEventListener("DOMContentLoaded", function () {
            var AppBridge = window['app-bridge'];
            var createApp = AppBridge.default;
            var app = createApp({
              apiKey: '${process.env.SHOPIFY_API_KEY}',
              host: '${host}',
              forceRedirect: true
            });
          });
        </script>
        <style>
          body {
            font-family: sans-serif;
            text-align: center;
            padding: 80px;
          }
        </style>
      </head>
      <body>
        <h1>✅ Warranty Register App 已加载</h1>
        <p>店铺：${shop}</p>
      </body>
    </html>
  `);
});

app.listen(port, () => {
  console.log(`✅ App is running on port ${port}`);
});
