// --- DIAGNOSTIC SCRIPT ---
const shopifyApi = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');

// --- CONFIGURATION ---
const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_API_TOKEN,
} = process.env;

// Initialize clients
const shopify = shopifyApi.shopifyApi({
  apiKey: 'temp_key', apiSecretKey: 'temp_secret',
  scopes: ['read_products'],
  hostName: SHOPIFY_STORE_DOMAIN.replace('https://', ''),
  apiVersion: shopifyApi.LATEST_API_VERSION,
  isEmbeddedApp: false, isCustomStoreApp: true,
  adminApiAccessToken: SHOPIFY_ADMIN_API_TOKEN,
});

// --- The main diagnostic function ---
module.exports = async (req, res) => {
    console.log("BTI Sync DIAGNOSTIC MODE triggered...");
    const log = ["Diagnostic Started..."];

    // ----- EDIT THIS LINE WITH THE BTI PART NUMBER OF YOUR TEST VARIANT -----
    const BTI_PART_NUMBER_TO_FIND = "1K000000";

    try {
        log.push("Fetching ALL Shopify variants to find our target...");
        const shopifyVariants = await getAllShopifyVariants();
        log.push(`Found ${shopifyVariants.length} total variants in the store.`);

        const targetVariant = shopifyVariants.find(v => v.btiPartNumber && v.btiPartNumber.value === BTI_PART_NUMBER_TO_FIND);

        log.push("\n--- DIAGNOSTIC DUMP FOR TARGET VARIANT ---");
        if (targetVariant) {
            log.push("SUCCESS: Found the target variant!");
            log.push(JSON.stringify(targetVariant, null, 2));
        } else {
            log.push(`FAILURE: Could not find any variant with BTI Part Number: ${BTI_PART_NUMBER_TO_FIND}`);
            log.push("Please double-check the part number and ensure the metafield is saved correctly on the variant in Shopify.");
        }
        log.push("--- END DIAGNOSTIC DUMP ---");

    } catch (error) {
        console.error("An error occurred during diagnostic:", error);
        log.push(`\n--- ERROR --- \n${error.message}`);
    }
    
    console.log(log.join('\n'));
    res.status(200).send("Diagnostic complete. Check Vercel logs.");
};

// --- SHOPIFY API HELPER FUNCTIONS ---
async function getAllShopifyVariants() {
    const query = `
    query($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        edges {
          node {
            id
            title
            btiPartNumber: metafield(namespace: "custom", key: "bti_part_number") {
              id
              key
              namespace
              value
            }
          }
        }
        pageInfo { hasNextPage, endCursor }
      }
    }`;
    const client = new shopify.clients.Graphql({ session: getSession() });
    let allVariants = [];
    let hasNextPage = true; let cursor = null;
    do {
        const response = await client.query({ data: { query, variables: { cursor } } });
        if (!response.body.data.productVariants) {
            break;
        }
        const pageData = response.body.data.productVariants;
        allVariants.push(...pageData.edges.map(edge => edge.node));
        hasNextPage = pageData.pageInfo.hasNextPage;
        cursor = pageData.pageInfo.endCursor;
    } while (hasNextPage);
    return allVariants;
}

function getSession() {
    return {
        id: 'bti-sync-diagnostic-session',
        shop: SHOPIFY_STORE_DOMAIN,
        accessToken: SHOPIFY_ADMIN_API_TOKEN,
        state: 'not-used',
        isOnline: true,
    };
}
