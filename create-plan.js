// create-plan.js
import fetch from "node-fetch";

// Sandbox credentials
const clientId = "AUV0saoa-yFZ6vUoubefvdlqkHQwf5i6uNNV38s10QbsfKNZumrvrGA-Y93ICAt6GBiZDANLyZq9AAEO";
const secret = "EPkjqVSciPdiKbylUzqjQNSdEtQ09pX_mHKRzm1PGsENipdGTfyJwGQ7M82Dg68MHUgitXjlPQVCmMKW";

// PayPal API base
const base = "https://api-m.paypal.com";


// Get OAuth2 token
async function getAccessToken() {
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization":
        "Basic " +
        Buffer.from(clientId + ":" + secret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new Error(`Failed to get access token: ${response.status}`);
  }
  return response.json();
}

// Create product
async function createProduct(token, name, description) {
  const response = await fetch(`${base}/v1/catalogs/products`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name,
      description,
      type: "SERVICE",
      category: "SOFTWARE",
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create product: ${response.status}`);
  }
  return response.json();
}

// Create plan
async function createPlan(token, productId, planName, price) {
  const response = await fetch(`${base}/v1/billing/plans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      product_id: productId,
      name: planName,
      description: `${planName} subscription for YourSpace`,
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: {
            interval_unit: "MONTH",
            interval_count: 1,
          },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: {
              value: price.toString(),
              currency_code: "USD",
            },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: {
          value: "0",
          currency_code: "USD",
        },
        setup_fee_failure_action: "CONTINUE",
        payment_failure_threshold: 3,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create plan: ${response.status}`);
  }
  return response.json();
}

// Plans from your pricing.tsx
const plans = [
  { key: "starter", price: 9 },
  { key: "pro", price: 19 },
  { key: "business", price: 49 },
  
];

(async () => {
  try {
    const { access_token } = await getAccessToken();
    console.log("✅ Got Access Token");

    for (const plan of plans) {
      const product = await createProduct(
        access_token,
        `${plan.key} Plan`,
        `${plan.key} subscription for YourSpace`
      );
      console.log(`✅ Created Product for ${plan.key}:`, product.id);

      const billingPlan = await createPlan(
        access_token,
        product.id,
        `${plan.key} Plan`,
        plan.price
      );
      console.log(`✅ Created Billing Plan for ${plan.key}:`, billingPlan.id);

      console.log(`👉 Use this plan_id for ${plan.key}: ${billingPlan.id}\n`);
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
})();
