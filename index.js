import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import cors from 'cors';
import nodemailer from 'nodemailer';
// import dotenv from 'dotenv';
// dotenv.config();

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

// 判断域名，根据域名确定使用那个变量
function getShopifyStoreConfig(origin = '') {
  console.log(origin,'origin')
  if (origin.includes('frizzlife.co.uk')) {
    console.log(1111,process.env.SHOPIFY_UK_STORE_DOMAIN)
    return {
      domain: process.env.SHOPIFY_UK_STORE_DOMAIN,
      token: process.env.SHOPIFY_UK_ACCESS_TOKEN
    };
    
  } else if (origin.includes('frizzlife.de') || origin.includes('frizzlife.eu')) {
    console.log(2222,process.env.SHOPIFY_DE_STORE_DOMAIN)
    return {
      domain: process.env.SHOPIFY_DE_STORE_DOMAIN,
      token: process.env.SHOPIFY_DE_ACCESS_TOKEN
    };
  } else {
    console.log(333,process.env.SHOPIFY_STORE_DOMAIN)
    return {
      domain: process.env.SHOPIFY_STORE_DOMAIN,
      token: process.env.SHOPIFY_ACCESS_TOKEN
    };
  }
  
}

// 购买时间
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
app.post('/send-invite', async (req, res) => {
  const { customerId, } = req.body;
  if (!customerId || !/^\d+$/.test(customerId)) {
    console.warn('Invalid or missing customerId:', customerId);
    return res.status(200).json({ success: false, error: 'Invalid customerId' }); // ✅ 返回 200，避免 Flow 重试
  }

  try {

    const origin = req.get('origin') || '';
    const { domain, token } = getShopifyStoreConfig(origin);
    console.log(domain, token,"11223111")
    const response = await axios.post(
      `https://${domain}/admin/api/${process.env.SHOPIFY_API_VERSION}/customers/${customerId}/send_invite.json`,
      {
        customer_invite: {
        }
      },
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json"
        }
      }
    );
    console.log(response.data,"response.data")
    res.json({ success: true, result: response.data });
  } catch (error) {
    console.error('Send invite error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});
app.post('/proxy', async (req, res) => {
  const { customerId, newWarranty } = req.body;

  try {
    const warrantyInfo = getWarrantyInfo(newWarranty.purchase_date);

    // 默认使用 newWarranty.product_name
    let productName = newWarranty.product_name;

    if (newWarranty.remark) {
      try {
        const remarkObj = JSON.parse(newWarranty.remark);
        if (remarkObj.SellerSKU) {
          productName = remarkObj.SellerSKU; // ✅ 替换 product_name
        }
      } catch (e) {
        console.warn('无法解析 remark 字段，保留原始 product_name');
      }
    }

    // 构造最终对象
    const warrantyWithState = {
      ...newWarranty,
      ...warrantyInfo,
      product_name: productName
    };
    const origin = req.get('origin') || '';
    const { domain, token } = getShopifyStoreConfig(origin);

    const oldDataRes = await axios.get(
      `https://${domain}/admin/api/2023-10/customers/${customerId}/metafields.json`,
      {
        headers: {
          "X-Shopify-Access-Token": token
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
      ? `https://${domain}/admin/api/2023-10/metafields/${existingMetafield.id}.json`
      : `https://${domain}/admin/api/2023-10/metafields.json`;

    const response = await axios({
      method: existingMetafield ? 'put' : 'post',
      url: metafieldEndpoint,
      headers: {
        "X-Shopify-Access-Token": token,
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
app.post('/send-email', async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      }
    });

    const mailOptions = {
      from: `"网站联系表单" <zjoey087@gmail.com>`,
      to: "customer@frizzlife.com", // 发送到你的邮箱
      replyTo: email,
      subject: 'New Contact Form Message',
      text: message,
      html: `<p><strong>Name:</strong> ${name}</p>
             <p><strong>Email:</strong> ${email}</p>
             <p><strong>Message:</strong></p>
             <p>${message}</p>`
    };

    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: 'Email sent successfully.' });
  } catch (err) {
    console.error('Mail send error:', err);
    res.status(500).json({ success: false, error: 'Failed to send email.' });
  }
});
app.post('/delete', async (req, res) => {
  const { customerId, order_id } = req.body;

  if (!customerId || !order_id) {
    return res.status(400).json({ success: false, error: 'customerId 和 order_id 是必填字段' });
  }

  try {
    const origin = req.get('origin') || '';
    const { domain, token } = getShopifyStoreConfig(origin);

    const oldDataRes = await axios.get(
      `https://${domain}/admin/api/2023-10/customers/${customerId}/metafields.json`,
      {
        headers: {
          "X-Shopify-Access-Token": token
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
      `https://${domain}/admin/api/2023-10/metafields/${existingMetafield.id}.json`,
      { metafield: metafieldPayload },
      {
        headers: {
          "X-Shopify-Access-Token": token,
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
app.post('/', (req, res) => {
  console.warn('Flow 请求路径错误，但我们友好返回 200，防止重试');
  res.status(200).json({ success: false, message: 'Missing path, but handled gracefully.' });
});

app.listen(port, () => {
  console.log(`✅ App is running on port ${port}`);
});
